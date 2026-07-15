const webpush = require('web-push');
const admin = require('firebase-admin');

// ── CONFIG ────────────────────────────────────────────────────────────
webpush.setVapidDetails(
  'mailto:florea@florea.app',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── UTILS ─────────────────────────────────────────────────────────────
async function sendToSubs(subs, payload) {
  for (const { docId, sub } of subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
      console.log(`✅ Notif envoyée`);
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        await db.collection('subscriptions').doc(docId).delete();
        console.log('🗑️ Subscription expirée supprimée');
      } else {
        console.error('❌ Push error:', err.message);
      }
    }
  }
}

// ── MAIN ──────────────────────────────────────────────────────────────
async function main() {
  const now = Date.now();
  const nowDate = new Date(now);

  // Heure Paris (UTC+2 en été, UTC+1 en hiver)
  const utcHour = nowDate.getUTCHours();
  const parisHour = (utcHour + 2) % 24; // UTC+2 (été)
  const isReminderHour = parisHour >= 8 && parisHour <= 10;

  console.log(`🕐 Heure Paris: ${parisHour}h — Rappel quotidien: ${isReminderHour}`);

  // Charger tous les jardins et subscriptions
  const [gardensSnap, subsSnap] = await Promise.all([
    db.collection('gardens').get(),
    db.collection('subscriptions').get()
  ]);

  if (gardensSnap.empty) { console.log('Aucun jardin'); return; }

  // Grouper les subscriptions par gardenId
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
      console.log(`Jardin "${gardenName}" — aucun abonné, skip`);
      continue;
    }

    console.log(`\n🌿 Jardin "${gardenName}" — ${subs.length} abonné(s)`);

    const plantsSnap = await db.collection('gardens').doc(gardenId).collection('plants').get();
    if (plantsSnap.empty) { console.log('  Aucune plante'); continue; }

    const overduePlants = [];

    for (const plantDoc of plantsSnap.docs) {
      const p = plantDoc.data();
      if (!p.lastWatered) continue;

      const last = p.lastWatered.toDate
        ? p.lastWatered.toDate().getTime()
        : new Date(p.lastWatered).getTime();

      const nextWater = last + p.frequency * 86400000;
      const hoursLeft = (nextWater - now) / 3600000;
      const daysLate = Math.floor(-hoursLeft / 24);

      console.log(`  🌱 ${p.name} — dans ${hoursLeft.toFixed(1)}h`);

      // Notif préventive : dans ~1h
      if (hoursLeft >= 0.5 && hoursLeft <= 1.5) {
        await sendToSubs(subs, {
          title: 'Florea 🌿',
          body: `${p.emoji} ${p.name} aura besoin d'eau dans 1 heure !`,
          tag: `plant-soon-${plantDoc.id}`,
        });
      }
      // Notif immédiate : c'est l'heure
      else if (hoursLeft >= -1 && hoursLeft < 0.5) {
        await sendToSubs(subs, {
          title: 'Florea 🌿 — À arroser !',
          body: `${p.emoji} ${p.name} a besoin d'eau maintenant !`,
          tag: `plant-now-${plantDoc.id}`,
        });
      }
      // En retard → rappel quotidien groupé
      else if (hoursLeft < -1) {
        overduePlants.push({ p, daysLate });
      }
    }

    // Rappel quotidien groupé (8h-10h Paris)
    if (isReminderHour && overduePlants.length > 0) {
      let payload;
      if (overduePlants.length === 1) {
        const { p, daysLate } = overduePlants[0];
        const since = daysLate <= 0 ? "aujourd'hui" : `depuis ${daysLate} jour${daysLate > 1 ? 's' : ''}`;
        payload = {
          title: 'Florea 🌿 — Rappel',
          body: `${p.emoji} ${p.name} doit être arrosé ${since} !`,
          tag: `daily-${gardenId}`,
        };
      } else {
        const names = overduePlants.map(({ p }) => `${p.emoji} ${p.name}`).join(', ');
        payload = {
          title: `Florea 🌿 — ${overduePlants.length} plantes à arroser`,
          body: names,
          tag: `daily-${gardenId}`,
        };
      }
      await sendToSubs(subs, payload);
      console.log(`  📬 Rappel quotidien envoyé pour ${overduePlants.length} plante(s)`);
    }
  }

  console.log('\n✅ Terminé');
  process.exit(0);
}

main().catch(err => {
  console.error('💥 Erreur fatale:', err);
  process.exit(1);
});
