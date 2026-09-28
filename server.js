const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const serviceAccount = require("/etc/secrets/firebase-service-account.json");
const firebaseApp = initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore(firebaseApp);
const auth = getAuth(firebaseApp);


async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
      console.log("AUTH HEADER:", header ? "PRESENT" : "MISSING");
    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Login required" });
    }

    const token = header.substring(7);
    req.user = await auth.verifyIdToken(token);
    next();
  } catch (error) {
    console.error("AUTH ERROR:", error.message);
    return res.status(401).json({ error: "Invalid login token" });
  }
}

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


app.post("/api/order", requireAuth, async (req, res) => {
  let localOrderRef = null;

  try {
    const { service, link, quantity } = req.body || {};
    const qty = Number(quantity);

    if (!service || !link || !Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({
        error: "service, link and valid quantity are required"
      });
    }

    // Get the real service data from FatherSMM.
    const servicesData = await fatherAPI({ action: "services" });
    const services = Array.isArray(servicesData)
      ? servicesData
      : (servicesData.services || []);

    const selected = services.find(
      item => String(item.service) === String(service)
    );

    if (!selected) {
      return res.status(400).json({ error: "Service not found" });
    }

    const rate = Number(selected.rate);
    const min = Number(selected.min);
    const max = Number(selected.max);

    if (!Number.isFinite(rate) || rate <= 0) {
      return res.status(400).json({ error: "Invalid service price" });
    }

    if (Number.isFinite(min) && qty < min) {
      return res.status(400).json({
        error: `Minimum quantity is ${min}`
      });
    }

    if (Number.isFinite(max) && qty > max) {
      return res.status(400).json({
        error: `Maximum quantity is ${max}`
      });
    }

    const amount = Number(((qty / 1000) * rate).toFixed(2));
    const userRef = db.collection("Users").doc(req.user.uid);
    localOrderRef = db.collection("orders").doc();

    // Deduct balance and create a local order atomically.
    await db.runTransaction(async transaction => {
      const userSnap = await transaction.get(userRef);

      if (!userSnap.exists) {
        throw new Error("USER_NOT_FOUND");
      }

      const userData = userSnap.data() || {};
      const balance = Number(userData.balance || 0);

      if (!Number.isFinite(balance) || balance < amount) {
        throw new Error("INSUFFICIENT_BALANCE");
      }

      transaction.update(userRef, {
        balance: Number((balance - amount).toFixed(2))
      });

      transaction.set(localOrderRef, {
        userId: req.user.uid,
        userEmail: req.user.email || userData.email || "",
        providerOrderId: null,
        providerServiceId: String(service),
        serviceName: selected.name || `Service ${service}`,
        category: selected.category || "",
        link: String(link),
        quantity: qty,
        rate: rate,
        amount: amount,
        status: "Processing",
        providerStatus: "Creating",
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
    });

    // Create the real order at FatherSMM.
    const providerData = await fatherAPI({
      action: "add",
      service: String(service),
      link: String(link),
      quantity: String(qty)
    });

    if (!providerData || !providerData.order) {
      // Provider failed: refund the user's balance.
      await db.runTransaction(async transaction => {
        const userSnap = await transaction.get(userRef);
        const currentBalance = Number(
          (userSnap.data() || {}).balance || 0
        );

        transaction.update(userRef, {
          balance: Number((currentBalance + amount).toFixed(2))
        });

        transaction.update(localOrderRef, {
          status: "Failed",
          providerStatus: "Failed",
          providerResponse: providerData || null,
          updatedAt: FieldValue.serverTimestamp()
        });
      });

      return res.status(400).json({
        error: providerData?.error || "FatherSMM order failed"
      });
    }

    await localOrderRef.update({
      providerOrderId: String(providerData.order),
      status: "Pending",
      providerStatus: "Pending",
      providerResponse: providerData,
      updatedAt: FieldValue.serverTimestamp()
    });

    return res.json({
      success: true,
      order: String(providerData.order),
      localOrderId: localOrderRef.id,
      amount: amount,
      status: "Pending"
    });

  } catch (error) {
    console.error("ORDER ERROR:", error);

    if (error.message === "INSUFFICIENT_BALANCE") {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    if (error.message === "USER_NOT_FOUND") {
      return res.status(404).json({ error: "User account not found" });
    }

    return res.status(500).json({
      error: "Order processing failed"
    });
  }
});


app.get("/api/my-orders", requireAuth, async (req, res) => {
  try {
    const snapshot = await db.collection("orders")
      .where("userId", "==", req.user.uid)
      .get();

    const orders = [];

    for (const doc of snapshot.docs) {
      const data = doc.data();
      let updatedData = { ...data };

      if (data.providerOrderId) {
        try {
          const providerStatus = await fatherAPI({
            action: "status",
            order: String(data.providerOrderId)
          });

          if (providerStatus && providerStatus.status) {
            updatedData.status = String(providerStatus.status);
            updatedData.providerStatus = String(providerStatus.status);
            updatedData.providerDetails = providerStatus;

            await doc.ref.update({
              status: updatedData.status,
              providerStatus: updatedData.providerStatus,
              providerDetails: providerStatus,
              updatedAt: FieldValue.serverTimestamp()
            });
          }
        } catch (statusError) {
          console.error(
            "STATUS SYNC ERROR:",
            data.providerOrderId,
            statusError.message
          );
        }
      }

      orders.push({
        id: doc.id,
        data: updatedData
      });
    }

    orders.sort((a, b) => {
      const aTime = a.data.createdAt?.toMillis
        ? a.data.createdAt.toMillis()
        : 0;
      const bTime = b.data.createdAt?.toMillis
        ? b.data.createdAt.toMillis()
        : 0;
      return bTime - aTime;
    });

    return res.json({
      success: true,
      orders
    });

  } catch (error) {
    console.error("MY ORDERS ERROR:", error);
    return res.status(500).json({
      error: "Failed to load orders"
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`GULSAN API running on port ${PORT}`);
});
