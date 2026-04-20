const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const path = require("path");

const app = express();
app.use(express.json());

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// List of active client passwords
// Add a new line for each paying client
// Remove the line if they stop paying
const ACTIVE_PASSWORDS = [
  "spicegarden2024",
  "dentalcare2024",
  "reviewmagic2024",
];

// Password check middleware
app.use((req, res, next) => {
  // Always allow static files through
  if (req.path === "/" || req.path.endsWith(".html") || req.path.endsWith(".css") || req.path.endsWith(".js")) {
    return next();
  }
  next();
});

// Serve login page at root
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// Verify password
app.post("/verify", (req, res) => {
  const { password } = req.body;
  if (ACTIVE_PASSWORDS.includes(password)) {
    res.json({ success: true });
  } else {
    res.json({ success: false, error: "Invalid password. Please contact support." });
  }
});

// Serve main app
app.get("/app", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Generate response
app.post("/generate", async (req, res) => {
  const { businessName, businessType, review, tone, stars, password } = req.body;

  // Check password on every generate request too
  if (!ACTIVE_PASSWORDS.includes(password)) {
    return res.status(401).json({ error: "Unauthorized. Please log in again." });
  }

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Review Responder running on port ${PORT}`);
});
