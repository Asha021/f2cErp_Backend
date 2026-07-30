const mysql = require('mysql2/promise');
const http = require('http');

async function test() {
    try {
        const pool = mysql.createPool({
            host: 'localhost',
            user: 'root',
            password: '',
            database: 'uaconsu1_f2cerp'
        });
        
        const [users] = await pool.query('SELECT * FROM users LIMIT 1');
        const user = users[0];
        const jwt = require('jsonwebtoken');
        const token = jwt.sign({ id: user.id, company_id: user.company_id, role: user.role }, 'change_this_to_a_long_random_secret', { expiresIn: '8h' });
        
        const postData = JSON.stringify({
            stages: [{ id: 6, order_index: 2 }, { id: 7, order_index: 1 }]
        });

        const options = {
            hostname: 'localhost',
            port: 5000,
            path: '/api/workflow/stages/reorder',
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = http.request(options, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                console.log(`STATUS: ${res.statusCode}`);
                console.log(`BODY: ${data}`);
                process.exit(0);
            });
        });

        req.on('error', error => {
            console.error(error);
            process.exit(1);
        });

        req.write(postData);
        req.end();
        
    } catch(err) {
        console.error(err.message);
        process.exit(1);
    }
}
test();
