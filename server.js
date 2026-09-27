const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const API_URL = "https://fathersmm.com/api/v2";

async function fatherAPI(params) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      key: process.env.FATHER_API_KEY,
      ...params
    })
  });

  return response.json();
}

app.get("/", (req, res) => {
  res.json({
    status: "GULSAN API Proxy is running"
  });
});

app.get("/api/services", async (req, res) => {
  try {
    const data = await fatherAPI({
      action: "services"
    });

    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "API request failed"
    });
  }
});


app.post("/api/order", async (req, res) => {
  try {
    const { service, link, quantity } = req.body || {};

    if (!service || !link || !quantity) {
      return res.status(400).json({
        error: "service, link and quantity are required"
      });
    }

    const data = await fatherAPI({
      action: "add",
      service: String(service),
      link: String(link),
      quantity: String(quantity)
    });

    res.json(data);
  } catch (error) {
    console.error("ORDER ERROR:", error);
    res.status(500).json({
      error: "Order API request failed"
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`GULSAN API running on port ${PORT}`);
});
