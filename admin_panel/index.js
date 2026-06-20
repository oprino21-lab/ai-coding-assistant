import express from 'express';
import bodyParser from 'body-parser';

const app = express();
app.use(bodyParser.json());

app.get('/admin', (req, res) => {
    res.send('Admin Panel');
});

app.listen(3000, () => {
    console.log('Admin panel running on http://localhost:3000');
});