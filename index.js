const express = require('express');
// const {z} = require('zod')
// const bcrypt = require('bcrypt')
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
// const ProfileModel = require('./Models/profiles');
// const WorkoutPlanModel = require('./Models/workoutPlans');

const Message = require('./models/Message');
// const jwt = require("jsonwebtoken")
const cors = require("cors")
// const cloudinary = require('cloudinary').v2;
require('dotenv').config();



const http = require('http');
const { Server } = require("socket.io");

const app = express();
app.use(express.json());

app.use(cors());

// app.use((req, res, next) => {
//     res.header('Access-Control-Allow-Origin', '*');
//     res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
//     res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
//     if (req.method === 'OPTIONS') {
//         return res.status(200).json({});
//     }
//     next();
// });

const server = http.createServer(app); // Create an HTTP server from the Express app

// Attach Socket.IO to the HTTP server with its own CORS settings
const io = new Server(server, {
  cors: {
    origin: "*", // Allow connections from your frontend
    methods: ["GET", "POST"]
  }
});

// const JWT_SECRET = process.env.JWT_SECRET
// const SALT_ROUNDS = 10

mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("Connected to MongoDB"))
    .catch((error) => console.error("MongoDB connection error: ", error));


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
        res.status(201).json(newMessage); // Respond with the newly created message

    } catch (error) {
        console.error("Error posting new message:", error);
        res.status(500).json({ message: "Server error while posting new message." });
    }
});


    app.get('/api/conversations', async (req, res) => {
    try {
        // We use an aggregation pipeline to group messages by user (`wa_id`)
        // and get the latest message for each user to display in the chat list.
        const conversations = await Message.aggregate([
            // Sort messages by timestamp to easily find the latest one
            { $sort: { timestamp: -1 } },
            // Group by user ID
            {
                $group: {
                    _id: "$wa_id", // Group by the WhatsApp ID
                    name: { $first: "$name" }, // Get the name of the user
                    lastMessage: { $first: "$text" }, // Get the text of the most recent message
                    lastMessageTimestamp: { $first: "$timestamp" }, // Get the timestamp of that message
                }
            },
            // Sort the conversations themselves by the last message's time
            { $sort: { lastMessageTimestamp: -1 } },
            // Rename _id to wa_id for cleaner output
            {
                $project: {
                    _id: 0, // Exclude the default _id field
                    wa_id: "$_id",
                    name: 1,
                    lastMessage: 1,
                    lastMessageTimestamp: 1
                }
            }
        ]);
        res.json(conversations);
    } catch (error) {
        console.error("Error fetching conversations:", error);
        res.status(500).json({ message: "Server error while fetching conversations." });
    }
});


// --- 2. GET All Messages for a Specific User ---
// This endpoint gets the full chat history for a selected user.
app.get('/api/messages/:wa_id', async (req, res) => {
    try {
        const { wa_id } = req.params; // Get the user ID from the URL
        const messages = await Message.find({ wa_id: wa_id })
                                      .sort({ timestamp: 'asc' }); // Sort by time ascending

        if (!messages) {
            return res.status(404).json({ message: "No messages found for this user." });
        }
        res.json(messages);
    } catch (error) {
        console.error("Error fetching messages:", error);
        res.status(500).json({ message: "Server error while fetching messages." });
    }
});
// ------------------------------------------------------------------



io.on('connection', (socket) => {
  console.log(`User Connected: ${socket.id}`);

  // Event for when a user selects a chat and "joins" the room
  socket.on('joinRoom', async (wa_id) => {
    socket.join(wa_id); // Join a room specific to this conversation
    console.log(`User ${socket.id} joined room: ${wa_id}`);
    
    // Load existing messages and send them to the client
    const messages = await Message.find({ wa_id }).sort({ timestamp: 'asc' });
    socket.emit('loadMessages', messages);
  });

  // Event for when a user sends a new message
  socket.on('sendMessage', async (data) => {
    const { wa_id, text } = data;

    // Find user info to save the message correctly
    const user = await Message.findOne({ wa_id });
     if (!user) {
        console.error("Could not find contact to send message to:", wa_id);
        return; 
    }


    const newMessage = new Message({
      id: `wamid.generated.${uuidv4()}`, 
      wa_id: wa_id,
      name: user.name,
      text: text,
      timestamp: Math.floor(Date.now() / 1000),
      status: 'sent',
       from: process.env.BUSINESS_PHONE_ID 
    });

    try {
        await newMessage.save();

        // Broadcast the new message to everyone in that specific conversation room
        io.to(wa_id).emit('receiveMessage', newMessage);

        console.log(`Saved and broadcasted new message from ${newMessage.from} to ${wa_id}`);
    } catch (error) {
        console.error("Error saving message sent from UI:", error);
    }
  });

  socket.on('disconnect', () => {
    console.log('User Disconnected', socket.id);
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