const jwt = require('jsonwebtoken');
require('dotenv').config();

const token = jwt.sign({ user_id: 1, company_id: 999, role: 'superadmin' }, process.env.JWT_SECRET || 'change_this_to_a_long_random_secret');

async function test() {
  try {
    const data = [{
      factory: 'Test Factory',
      item_no: 'ITEM1',
      quantity: 10,
      price: 100,
      po_date: '2026-07-25',
      delivery_date: '2026-08-25'
    }];
    const res = await fetch('http://localhost:5000/api/purchase-orders/import', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ data })
    });
    const json = await res.json();
    console.log("Response:", json);
  } catch (err) {
    console.log("Error:", err);
  }
}

test();
