import express from 'express';
import bodyParser from 'body-parser';
import routes from './routes.js';

const app = express();
app.use(bodyParser.json());
app.use('/admin', routes);

app.listen(3000, () => {
    console.log('Admin panel running on http://localhost:3000');
});