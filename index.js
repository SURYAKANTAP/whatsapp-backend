const express = require('express');

const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const Message = require('./models/Message');

const cors = require("cors")

require('dotenv').config();



const http = require('http');
const { Server } = require("socket.io");
const Redis = require("ioredis");

const app = express();
app.use(express.json());

app.use(cors());

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("./models/User");
const auth = require("./middleware/auth");

// Redis setup
const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
    password: process.env.REDIS_PASSWORD
});

redis.on('connect', () => {
    console.log('Redis connected');
});

const server = http.createServer(app); // Create an HTTP server from the Express app

// Attach Socket.IO to the HTTP server with its own CORS settings
const io = new Server(server, {
  cors: {
    origin: "*", // Allow connections from your frontend
    methods: ["GET", "POST"]
  }
});




mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("Connected to MongoDB"))
    .catch((error) => console.error("MongoDB connection error: ", error));




    // Signup
app.post("/signup", async (req, res) => {
  const { email, password } = req.body;

  try {
    let user = await User.findOne({ email });
    if (user) {
      return res.status(400).json({ msg: "User already exists" });
    }

    user = new User({
      email,
      password,
    });

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(password, salt);

    await user.save();

    const payload = {
      user: {
        id: user.id,
        email: user.email
      },
    };

    jwt.sign(
      payload,
      process.env.JWT_SECRET,
      { expiresIn: 3600 },
      (err, token) => {
        if (err) throw err;
        res.json({ token });
      }
    );
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server error");
  }
});

// Login
app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    let user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ msg: "Invalid credentials" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ msg: "Invalid credentials" });
    }

    const payload = {
      user: {
        id: user.id,
        email: user.email
      },
    };

    jwt.sign(
      payload,
      process.env.JWT_SECRET,
      { expiresIn: 3600 },
      (err, token) => {
        if (err) throw err;
        res.json({ token });
      }
    );
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server error");
  }
});


app.get("/users", auth, async (req, res) => {
  try {
    const users = await User.find().select("-password");
    res.json(users);
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server Error");
  }
});


app.get('/users/:userId', auth, async (req, res) => {
    try {
        const user = await User.findById(req.params.userId).select('-password'); // Find by ID and exclude the password
        if (!user) {
            return res.status(404).json({ msg: 'User not found' });
        }
        res.json(user);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});


app.post('/api/messages', async (req, res) => {
    try {
        const { wa_id, text } = req.body; // Get user ID and text from the request

        // Basic validation
        if (!wa_id || !text) {
            return res.status(400).json({ message: 'wa_id and text are required.' });
        }

        // Find the user's name from an existing message
        const user = await Message.findOne({ wa_id: wa_id });
        if (!user) {
            return res.status(404).json({ message: "Cannot send message to a user with no prior conversation." });
        }

        const newMessage = new Message({
            id: new mongoose.Types.ObjectId().toString(), // Generate a unique ID
            wa_id: wa_id,
            name: user.name, // Reuse the name from the existing conversation
            text: text,
            timestamp: Math.floor(Date.now() / 1000), // Current time as Unix timestamp
            status: 'sent' // Default status for UI-sent messages
        });

        await newMessage.save();
        io.to(wa_id).emit('receiveMessage', newMessage);
        res.status(201).json(newMessage); // Respond with the newly created message

    } catch (error) {
        console.error("Error posting new message:", error);
        res.status(500).json({ message: "Server error while posting new message." });
    }
});


    app.get('/api/conversations', auth, async (req, res) => {
    try {
        const userId = req.user.id;
        const messages = await Message.find({ $or: [{ sender: userId }, { recipient: userId }] })
            .sort({ timestamp: -1 })
            // --- THE FIX IS HERE ---
            // We now explicitly ask for BOTH _id and email in the populated documents.
            .populate('sender', '_id email')
            .populate('recipient', '_id email');

        const conversations = new Map();
        messages.forEach(message => {
            // This logic is now safe because both sender and recipient have an _id
            const otherUser = message.sender._id.toString() === userId ? message.recipient : message.sender;
            if (!conversations.has(otherUser._id.toString())) {
                conversations.set(otherUser._id.toString(), {
                    otherUser,
                    lastMessage: message
                });
            }
        });

        res.json(Array.from(conversations.values()));
    } catch (error) {
        console.error("Error fetching conversations:", error);
        res.status(500).json({ message: "Server error." });
    }
});


// --- 2. GET All Messages for a Specific User ---
// This endpoint gets the full chat history for a selected user.
app.get('/api/messages/:otherUserId', auth, async (req, res) => {
    try {
        const myId = req.user.id;
        const otherUserId = req.params.otherUserId;

        // --- THE FIX IS HERE ---
        // We MUST use the 'new' keyword to create new instances of ObjectId.
        const messages = await Message.find({
            $or: [
                { sender: new mongoose.Types.ObjectId(myId), recipient: new mongoose.Types.ObjectId(otherUserId) },
                { sender: new mongoose.Types.ObjectId(otherUserId), recipient: new mongoose.Types.ObjectId(myId) }
            ]
        }).sort({ timestamp: 'asc' });
        
        res.json(messages);
    } catch (error) {
        // This catch block is now very important for debugging!
        console.error("Error fetching messages:", error); 
        res.status(500).json({ message: "Server error." });
    }
});


// =================================================================
// ADVANCED LOGIC: REAL-TIME PRESENCE AND DIRECT MESSAGING
// =================================================================

const ONLINE_USERS_REDIS_KEY = 'online_users';
const userSocketMap = new Map(); // In-memory map: userId -> socket.id

io.on('connection', (socket) => {
  console.log(`User Connected: ${socket.id}`);

  // 1. User comes online
  socket.on('goOnline', async (userId) => {
    socket.userId = userId;
    userSocketMap.set(userId, socket.id);
    await redis.sadd(ONLINE_USERS_REDIS_KEY, userId);
    console.log(`User ${userId} is now online.`);

     // --- NEW CODE: BROADCAST THE UPDATED ONLINE LIST ---
    const onlineUserIds = Array.from(userSocketMap.keys());
    io.emit('onlineUsersUpdate', onlineUserIds); // Send to everyone

    // 2. DELIVER MISSED MESSAGES
    const missedMessages = await Message.find({
      recipient: userId,
      status: 'sent'
    }).sort({ timestamp: 'asc' });

    if (missedMessages.length > 0) {
      socket.emit('missedMessages', missedMessages);
      console.log(`Delivered ${missedMessages.length} missed messages to user ${userId}.`);
      
      const messageIds = missedMessages.map(msg => msg._id);
      await Message.updateMany(
        { _id: { $in: messageIds } },
        { $set: { status: 'delivered' } }
      );
    }
  });

  // 3. User sends a message
  socket.on('sendMessage', async (data) => {
    const { text, sender, recipient } = data;

    const newMessage = new Message({
      sender,
      recipient,
      text,
      timestamp: Math.floor(Date.now() / 1000),
      status: 'sent'
    });
    await newMessage.save();

    // 4. REAL-TIME DELIVERY LOGIC
    const isRecipientOnline = await redis.sismember(ONLINE_USERS_REDIS_KEY, recipient);
    if (isRecipientOnline) {
      const recipientSocketId = userSocketMap.get(recipient);
      if (recipientSocketId) {
        io.to(recipientSocketId).emit('receiveMessage', newMessage);
        newMessage.status = 'delivered';
        await newMessage.save(); // Update status in DB
      }
    }
    
    // Echo message back to sender so their UI updates instantly
    socket.emit('receiveMessage', newMessage);
  });

  // 5. User disconnects
  socket.on('disconnect', async () => {
    if (socket.userId) {
      userSocketMap.delete(socket.userId);
      await redis.srem(ONLINE_USERS_REDIS_KEY, socket.userId);
      console.log(`User ${socket.userId} went offline.`);

      // --- NEW CODE: BROADCAST THE UPDATED ONLINE LIST ---
      const onlineUserIds = Array.from(userSocketMap.keys());
      io.emit('onlineUsersUpdate', onlineUserIds); // Send to everyone
    }
    console.log('User Disconnected', socket.id);
  });


  // --- NEW LISTENER FOR READ RECEIPTS ---
  socket.on('markAsRead', async (data) => {
    if (!socket.userId || !data.otherUserId) return;

    try {
      // 1. Update the messages in the database
      // Find all messages sent by the other user to me that are not already 'read'
      const result = await Message.updateMany(
        {
          sender: data.otherUserId,
          recipient: socket.userId,
          status: { $ne: 'read' } // Only update if not already read
        },
        { $set: { status: 'read' } }
      );
      
      // If any messages were updated, notify the sender
      if (result.nModified > 0) {
        // 2. Notify the original sender that their messages were read
        const senderSocketId = userSocketMap.get(data.otherUserId);
        if (senderSocketId) {
          io.to(senderSocketId).emit('messagesRead', {
            // Tell the sender which conversation was read
            conversationPartnerId: socket.userId 
          });
        }
      }
    } catch (error) {
      console.error('Error marking messages as read:', error);
    }
  });
});

// Basic Route
app.get('/', (req, res) => {
    res.send('WhatsApp Clone Backend is Running!');
});


const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});