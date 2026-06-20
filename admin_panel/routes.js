import express from 'express';
const router = express.Router();

router.get('/dashboard', (req, res) => {
    res.send('Dashboard');
});

router.get('/settings', (req, res) => {
    res.send('Settings');
});

export default router;