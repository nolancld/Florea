const webpush = require('web-push');
const admin = require('firebase-admin');

webpush.setVapidDetails(
  'mailto:florea@florea.app',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const isManualRun = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';

// ── SEND ─────────────────────────────────────────────────────────────
async function sendToSubs(subs, payload) {
  for (const { docId, sub } of subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
      console.log(`  ✅ Envoyé (...${(sub.endpoint||'').slice(-15)})`);
    } catch (err) {
      console.error(`  ❌ Échec ${err.statusCode}: ${String(err.body).slice(0,80)}`);
      if (err.statusCode === 410 || err.statusCode === 404) {
        await db.collection('subscriptions').doc(docId).delete();
        console.log('  🗑️ Subscription expirée supprimée');
      }
    }
  }
}

// ── NOTIF STATE ───────────────────────────────────────────────────────
// _notif_state/{gardenId}_{plantId} = { sentAt, count, nextSendAfter }
// nextSendAfter = timestamp unix en ms avant lequel on n'envoie pas

async function getState(gardenId, plantId) {
  try {
    const snap = await db.collection('_notif_state').doc(`${gardenId}_${plantId}`).get();
    return snap.exists ? snap.data() : null;
  } catch { return null; }
}

async function setState(gardenId, plantId, data) {
  try {
    await db.collection('_notif_state').doc(`${gardenId}_${plantId}`).set(data);
  } catch(e) { console.error('setState error:', e.message); }
}

async function clearState(gardenId, plantId) {
  try {
    await db.collection('_notif_state').doc(`${gardenId}_${plantId}`).delete();
  } catch {}
}

function toMs(firestoreVal) {
  if (!firestoreVal) return 0;
  if (firestoreVal.toDate) return firestoreVal.toDate().getTime();
  return Number(firestoreVal);
}

// ── MAIN ──────────────────────────────────────────────────────────────
async function main() {
  const now = Date.now();
  const nowDate = new Date(now);
  console.log(`🕐 ${nowDate.toISOString()}`);
  console.log(`📋 Run ${isManualRun ? 'MANUEL' : 'automatique'}\n`);

  const [gardensSnap, subsSnap] = await Promise.all([
    db.collection('gardens').get(),
    db.collection('subscriptions').get()
  ]);

  if (gardensSnap.empty) { console.log('Aucun jardin'); return; }

  // Grouper subs par jardin
  const subsByGarden = {};
  subsSnap.docs.forEach(d => {
    const { subscription, gardenId } = d.data();
    if (!gardenId || !subscription) return;
    if (!subsByGarden[gardenId]) subsByGarden[gardenId] = [];
    subsByGarden[gardenId].push({ docId: d.id, sub: subscription });
  });

  for (const gardenDoc of gardensSnap.docs) {
    const gardenId = gardenDoc.id;
    const gardenName = gardenDoc.data().name || 'Jardin';
    const subs = subsByGarden[gardenId];
    if (!subs || subs.length === 0) {
      console.log(`🌿 "${gardenName}" — aucun abonné, skip\n`);
      continue;
    }

    console.log(`🌿 "${gardenName}" — ${subs.length} abonné(s)`);

    const plantsSnap = await db.collection('gardens').doc(gardenId).collection('plants').get();
    if (plantsSnap.empty) { console.log('  Aucune plante\n'); continue; }

    for (const plantDoc of plantsSnap.docs) {
      const p = plantDoc.data();
      if (!p.lastWatered) continue;

      const last = p.lastWatered.toDate
        ? p.lastWatered.toDate().getTime()
        : new Date(p.lastWatered).getTime();

      const nextWater = last + p.frequency * 86400000;
      const hoursLeft = (nextWater - now) / 3600000;

      console.log(`  🌱 ${p.name} — dans ${hoursLeft.toFixed(1)}h`);

      // Plante à jour → effacer l'état
      if (hoursLeft > 1) {
        await clearState(gardenId, plantDoc.id);
        continue;
      }

      // Plante bientôt due ou en retard
      const state = await getState(gardenId, plantDoc.id);
      const count = state?.count || 0;
      const nextSendAfter = toMs(state?.nextSendAfter) || 0;

      // Ne pas envoyer si on doit attendre (sauf run manuel)
      if (!isManualRun && now < nextSendAfter) {
        const waitH = ((nextSendAfter - now) / 3600000).toFixed(1);
        console.log(`    ⏭️ Prochain envoi dans ${waitH}h (${count} notif(s) déjà envoyées)`);
        continue;
      }

      // Calculer le délai avant la prochaine notif selon le nombre déjà envoyées
      let nextDelayMs;
      let title, body;
      const daysLate = Math.max(0, -hoursLeft / 24);

      if (count === 0 && hoursLeft >= -1 && hoursLeft <= 1) {
        // Notif d'échéance : c'est l'heure !
        title = 'Florea 🌿 — C\'est l\'heure !';
        body = `${p.emoji} ${p.name} doit être arrosé aujourd'hui !`;
        nextDelayMs = 10 * 3600000; // prochain dans 10h
      } else if (count === 0 && hoursLeft < -1) {
        // Première notif mais déjà en retard (run raté)
        title = 'Florea 🌿 — À arroser !';
        body = `${p.emoji} ${p.name} aurait dû être arrosé il y a ${Math.floor(daysLate * 24)}h !`;
        nextDelayMs = 8 * 3600000;
      } else if (count <= 4) {
        // Rappels J+1 à J+3 : toutes les 8h
        title = 'Florea 🌿 — Rappel';
        body = `${p.emoji} ${p.name} attend d'être arrosé depuis ${Math.floor(daysLate)} jour${Math.floor(daysLate) > 1 ? 's' : ''} !`;
        nextDelayMs = 8 * 3600000;
      } else if (count <= 7) {
        // J+4 à J+7 : 1 fois par jour
        title = 'Florea 🌿 — Rappel';
        body = `${p.emoji} ${p.name} n'a pas été arrosé depuis ${Math.floor(daysLate)} jours !`;
        nextDelayMs = 24 * 3600000;
      } else if (count <= 9) {
        // Semaine suivante : 1 fois par semaine
        title = 'Florea 🌿';
        body = `${p.emoji} ${p.name} attend toujours d'être arrosé...`;
        nextDelayMs = 7 * 24 * 3600000;
      } else {
        // Plus de notif après 10 envois
        console.log(`    🔕 Limite de notifs atteinte (${count}), on arrête`);
        continue;
      }

      console.log(`    📬 Envoi notif #${count + 1}`);
      await sendToSubs(subs, { title, body, tag: `plant-${plantDoc.id}` });

      // Sauvegarder l'état seulement pour les runs automatiques
      if (!isManualRun) {
        await setState(gardenId, plantDoc.id, {
          count: count + 1,
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
          nextSendAfter: now + nextDelayMs,
          plantName: p.name,
        });
      }
    }
    console.log('');
  }

  console.log('✅ Terminé');
  process.exit(0);
}

main().catch(err => {
  console.error('💥 Erreur fatale:', err);
  process.exit(1);
});
