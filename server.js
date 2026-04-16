const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json());

// --- Config from environment variables ---
const SQUARE_TOKEN = process.env.SQUARE_TOKEN;
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL;
const SQUARE_BASE = 'https://connect.squareup.com/v2';

// --- Firebase Admin init ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: FIREBASE_DB_URL
});
const db = admin.database();

// --- Course catalog item IDs (set after setup) ---
// These are populated by the /setup endpoint on first run
let COURSE_ITEMS = {};

// --- Course definitions ---
const COURSES = [
  {
    key: 'arrival',
    name: 'FM Arrival',
    kitchenName: 'FEED ME: Bread + Olives + Dip Your Crusts',
    printer: 'back kitchen'
  },
  {
    key: 'smallplates',
    name: 'FM Small Plates',
    kitchenName: 'FEED ME: Arancini x4 + Meatballs x4',
    printer: 'back kitchen'
  },
  {
    key: 'pizza',
    name: 'FM Pizza & Dipper',
    kitchenName: 'FEED ME: Butcher of Brunswick + Saint Margaret + Dip',
    printer: 'pizza printer'
  },
  {
    key: 'salad',
    name: 'FM Salad & Chips',
    kitchenName: 'FEED ME: Salad & Chips',
    printer: 'back kitchen'
  },
  {
    key: 'tiramisu',
    name: 'FM Tiramisu',
    kitchenName: 'FEED ME: Tiramisu',
    printer: 'back kitchen'
  }
];

// --- Health check ---
app.get('/', (req, res) => {
  res.json({ status: 'Madonna Electric Feed Me server running', courses: Object.keys(COURSE_ITEMS).length > 0 ? 'configured' : 'needs setup' });
});

// --- Setup: create catalog items in Square ---
app.post('/setup', async (req, res) => {
  try {
    const results = [];
    for (const course of COURSES) {
      const body = {
        idempotency_key: `feedme-setup-${course.key}-v1`,
        object: {
          type: 'ITEM',
          id: `#${course.key}`,
          item_data: {
            name: course.name,
            kitchen_sink_name: course.kitchenName,
            variations: [{
              type: 'ITEM_VARIATION',
              id: `#${course.key}-var`,
              item_variation_data: {
                item_id: `#${course.key}`,
                name: 'Regular',
                pricing_type: 'FIXED_PRICING',
                price_money: { amount: 0, currency: 'AUD' }
              }
            }]
          }
        }
      };

      const r = await fetch(`${SQUARE_BASE}/catalog/object`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SQUARE_TOKEN}`,
          'Content-Type': 'application/json',
          'Square-Version': '2024-01-18'
        },
        body: JSON.stringify(body)
      });
      const data = await r.json();
      if (data.catalog_object) {
        const itemId = data.catalog_object.id;
        const varId = data.catalog_object.item_data.variations[0].id;
        COURSE_ITEMS[course.key] = { itemId, varId, ...course };
        results.push({ key: course.key, itemId, varId, status: 'created' });
      } else {
        results.push({ key: course.key, error: JSON.stringify(data.errors) });
      }
    }

    // Save to Firebase for persistence
    await db.ref('config/courseItems').set(COURSE_ITEMS);
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Fire a course: creates Square order + updates Firebase ---
app.post('/fire', async (req, res) => {
  const { tableNum, courseKey, covers, dietary } = req.body;

  if (!tableNum || !courseKey) {
    return res.status(400).json({ error: 'tableNum and courseKey required' });
  }

  // Load course items from Firebase if not in memory
  if (Object.keys(COURSE_ITEMS).length === 0) {
    const snap = await db.ref('config/courseItems').once('value');
    COURSE_ITEMS = snap.val() || {};
  }

  const course = COURSE_ITEMS[courseKey];
  if (!course) {
    return res.status(400).json({ error: `Course ${courseKey} not configured. Run /setup first.` });
  }

  try {
    // Build note with dietary info
    const dietNote = dietary && dietary !== 'standard'
      ? ` | DIETARY: ${dietary.toUpperCase()}`
      : '';
    const coverNote = covers ? ` | ${covers} covers` : '';
    const note = `TABLE ${tableNum}${coverNote}${dietNote}`;

    // Create Square order
    const orderBody = {
      idempotency_key: `fire-${tableNum}-${courseKey}-${Date.now()}`,
      order: {
        location_id: SQUARE_LOCATION_ID,
        reference_id: `FM-T${tableNum}-${courseKey}`,
        note: note,
        line_items: [{
          catalog_object_id: course.varId,
          quantity: String(covers || 1),
          note: `${course.kitchenName}${dietNote}`
        }]
      }
    };

    const r = await fetch(`${SQUARE_BASE}/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SQUARE_TOKEN}`,
        'Content-Type': 'application/json',
        'Square-Version': '2024-01-18'
      },
      body: JSON.stringify(orderBody)
    });

    const data = await r.json();

    if (data.order) {
      // Update Firebase - all clients will react instantly
      const firedAt = Date.now();
      await db.ref(`tables/${tableNum}/courses/${courseKey}`).set({
        fired: true,
        firedAt,
        orderId: data.order.id
      });
      await db.ref(`tables/${tableNum}/lastFired`).set({
        courseKey,
        firedAt
      });

      res.json({
        success: true,
        orderId: data.order.id,
        course: course.name,
        table: tableNum,
        firedAt
      });
    } else {
      res.status(500).json({ error: 'Square order failed', details: data.errors });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Add table to Firebase ---
app.post('/table/add', async (req, res) => {
  const { tableNum, std, veg, vgn } = req.body;
  if (!tableNum) return res.status(400).json({ error: 'tableNum required' });

  await db.ref(`tables/${tableNum}`).set({
    std: std || 0,
    veg: veg || 0,
    vgn: vgn || 0,
    currentCourse: 0,
    seatedAt: Date.now(),
    lastFired: null,
    courses: {}
  });

  res.json({ success: true, tableNum });
});

// --- Remove table from Firebase ---
app.delete('/table/:tableNum', async (req, res) => {
  await db.ref(`tables/${req.params.tableNum}`).remove();
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Feed Me server running on port ${PORT}`));
