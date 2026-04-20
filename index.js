const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static("public"));

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

app.post("/generate", async (req, res) => {
  const { businessName, businessType, review, tone, stars } = req.body;

  if (!businessName || !review) {
    return res.status(400).json({ error: "Business name and review are required." });
  }

  const starLabel = stars > 0 ? `${stars}-star` : "unrated";

  const prompt = `You are a professional reputation manager for a ${businessType} called "${businessName}".

A customer left this ${starLabel} review:
"${review}"

Write a ${tone.toLowerCase()} response to this review. Follow these rules:
- Keep it between 60 to 120 words
- Thank the customer naturally
- Address specific points they raised
- If the review is negative, acknowledge the issue sincerely and offer to make it right
- Do NOT use hollow phrases like "We value your feedback"
- End with a warm, forward-looking closing
- Write only the response text, no subject line or label`;

  try {
    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    });

    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    res.json({ response: text.trim() });
  } catch (error) {
    console.error("Anthropic error:", error.message);
    res.status(500).json({ error: "Failed to generate response. Check your API key." });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Review Responder running on port ${PORT}`);
});
