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
      console.error(`  ❌ Échec ${err.statusCode}: ${err.body?.slice(0,80)}`);
      if (err.statusCode === 410 || err.statusCode === 404) {
        await db.collection('subscriptions').doc(docId).delete();
        console.log('  🗑️ Subscription expirée supprimée');
      }
    }
  }
}

// ── NOTIFICATION STATE ────────────────────────────────────────────────
// Stocke dans Firestore quand on a envoyé la dernière notif par plante
// Structure: _notif_state/{gardenId}_{plantId} = { lastNotifAt, count }

async function getNotifState(gardenId, plantId) {
  try {
    const snap = await db.collection('_notif_state').doc(`${gardenId}_${plantId}`).get();
    return snap.exists ? snap.data() : null;
  } catch { return null; }
}

async function setNotifState(gardenId, plantId, data) {
  try {
    await db.collection('_notif_state').doc(`${gardenId}_${plantId}`).set(data);
  } catch (e) { console.error('Failed to save notif state:', e.message); }
}

async function clearNotifState(gardenId, plantId) {
  try {
    await db.collection('_notif_state').doc(`${gardenId}_${plantId}`).delete();
  } catch {}
}

// ── MAIN ──────────────────────────────────────────────────────────────
async function main() {
  const now = Date.now();
  const nowDate = new Date(now);
  const utcHour = nowDate.getUTCHours();
  const parisHour = (utcHour + 2) % 24;
  const parisMinute = nowDate.getUTCMinutes();

  console.log(`🕐 ${nowDate.toISOString()} — Paris: ${parisHour}h${String(parisMinute).padStart(2,'0')}`);
  console.log(`📋 Run ${isManualRun ? 'MANUEL' : 'automatique'}\n`);

  const [gardensSnap, subsSnap] = await Promise.all([
    db.collection('gardens').get(),
    db.collection('subscriptions').get()
  ]);

  if (gardensSnap.empty) { console.log('Aucun jardin'); return; }

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
      console.log(`🌿 "${gardenName}" — aucun abonné, skip`);
      continue;
    }

    console.log(`\n🌿 "${gardenName}" — ${subs.length} abonné(s)`);

    const plantsSnap = await db.collection('gardens').doc(gardenId).collection('plants').get();
    if (plantsSnap.empty) { console.log('  Aucune plante'); continue; }

    for (const plantDoc of plantsSnap.docs) {
      const p = plantDoc.data();
      if (!p.lastWatered) continue;

      const last = p.lastWatered.toDate
        ? p.lastWatered.toDate().getTime()
        : new Date(p.lastWatered).getTime();

      const nextWater = last + p.frequency * 86400000;
      const hoursLeft = (nextWater - now) / 3600000;
      const daysLate = Math.max(0, -hoursLeft / 24);

      console.log(`  🌱 ${p.name} — dans ${hoursLeft.toFixed(1)}h`);

      // Plante bien arrosée → effacer l'état de notif
      if (hoursLeft > 0) {
        await clearNotifState(gardenId, plantDoc.id);
        continue;
      }

      // Plante en retard
      const state = await getNotifState(gardenId, plantDoc.id);
      const lastNotifAt = state?.lastNotifAt?.toDate?.()?.getTime() || state?.lastNotifAt || 0;
      const notifCount = state?.count || 0;
      const hoursSinceLastNotif = (now - lastNotifAt) / 3600000;

      let shouldNotify = false;
      let reason = '';

      if (isManualRun) {
        // Run manuel → toujours envoyer
        shouldNotify = true;
        reason = 'run manuel';
      } else if (notifCount === 0) {
        // Première notif → dès que la plante est en retard
        shouldNotify = true;
        reason = 'première notif (plante en retard)';
      } else if (notifCount <= 6 && daysLate <= 3) {
        // Jours 1-3 : notif à 10h et 18h Paris
        const isNotifHour = (parisHour === 10 || parisHour === 18) && parisMinute < 60;
        if (isNotifHour && hoursSinceLastNotif >= 4) {
          shouldNotify = true;
          reason = `rappel J+${Math.floor(daysLate)} (${parisHour}h)`;
        }
      } else if (daysLate > 3 && daysLate <= 10) {
        // Jours 4-10 : 1 notif par jour à 10h
        const isNotifHour = parisHour === 10 && parisMinute < 60;
        if (isNotifHour && hoursSinceLastNotif >= 20) {
          shouldNotify = true;
          reason = `rappel quotidien J+${Math.floor(daysLate)}`;
        }
      } else if (daysLate > 10 && notifCount < 10) {
        // Après 10 jours : 1 notif par semaine
        if (hoursSinceLastNotif >= 168) {
          shouldNotify = true;
          reason = `rappel hebdo J+${Math.floor(daysLate)}`;
        }
      }
      // Plus de notif après ça

      if (!shouldNotify) {
        console.log(`    ⏭️ Pas de notif (${notifCount} envoyées, il y a ${hoursSinceLastNotif.toFixed(1)}h)`);
        continue;
      }

      const daysLateStr = daysLate < 1
        ? "aujourd'hui"
        : `depuis ${Math.floor(daysLate)} jour${Math.floor(daysLate) > 1 ? 's' : ''}`;

      const payload = {
        title: notifCount === 0 ? 'Florea 🌿 — À arroser !' : `Florea 🌿 — Rappel`,
        body: `${p.emoji} ${p.name} doit être arrosé ${daysLateStr} !`,
        tag: `plant-${plantDoc.id}`,
      };

      console.log(`    📬 Envoi (${reason})`);
      await sendToSubs(subs, payload);

      // Sauvegarder l'état
      if (!isManualRun) {
        await setNotifState(gardenId, plantDoc.id, {
          lastNotifAt: admin.firestore.FieldValue.serverTimestamp(),
          count: notifCount + 1,
          plantName: p.name,
        });
      }
    }
  }

  console.log('\n✅ Terminé');
  process.exit(0);
}

main().catch(err => {
  console.error('💥 Erreur fatale:', err);
  process.exit(1);
});
