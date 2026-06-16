const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

app.post("/ai", (req, res) => {
    const { task } = req.body;

    res.json({
        plan: [
            "Understand request",
            "Analyze code",
            "Generate solution"
        ],
        files: [
            {
                file: "example.js",
                change: "AI will generate real code later"
            }
        ],
        output: "Backend working successfully"
    });
});

app.listen(3000, () => {
    console.log("AI backend running on port 3000");
});
