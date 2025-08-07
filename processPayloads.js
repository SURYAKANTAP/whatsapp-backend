// a_process_payloads.js (CORRECTED)

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Message = require('./models/Message'); // Make sure this path is correct

dotenv.config();

const payloadsDir = path.join(__dirname, 'sample_payloads');

const processFiles = async () => {
    // --- Connect to DB ---
    await mongoose.connect(process.env.MONGO_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
    });
    console.log('MongoDB Connected for processing...');

    // Clear existing data to avoid duplicates on re-runs
    await Message.deleteMany({});
    console.log('Cleared existing messages.');

    const files = fs.readdirSync(payloadsDir);

    for (const file of files) {
        if (path.extname(file) !== '.json') continue;

        const filePath = path.join(payloadsDir, file);
        const rawData = fs.readFileSync(filePath);
        const payload = JSON.parse(rawData);

        let change;
        if (payload.metaData && payload.metaData.entry && payload.metaData.entry[0].changes) {
            change = payload.metaData.entry[0].changes[0];
        } else {
            console.warn(`--> Skipping file '${file}': could not find valid webhook data.`);
            continue;
        }

        if (!change.value) continue;

        const value = change.value;

        // --- Logic to process a new message ---
        if (value.messages && value.contacts && value.messages[0].text) {
            const messageData = value.messages[0];
            const contactData = value.contacts[0];

            try {
                const newMessage = new Message({
                    id: messageData.id,
                    wa_id: contactData.wa_id,
                    name: contactData.profile.name,
                    text: messageData.text.body,
                    timestamp: parseInt(messageData.timestamp, 10),
                    status: 'sent',

                    // =============================================================
                    // THE FIX: Add the 'from' field to be saved in the database
                    // This extracts the sender's ID from the raw message data.
                    // =============================================================
                    from: messageData.from, 
                });

                await newMessage.save();
                console.log(`Saved new message: ${newMessage.id} from ${newMessage.from}`);

            } catch (error) {
                if (error.code === 11000) {
                    console.warn(`--> Skipping duplicate message: ${messageData.id}`);
                } else {
                    console.error(`Error saving message from file ${file}:`, error);
                }
            }
        }

        // --- Logic to process a status update ---
        else if (value.statuses) {
            const statusData = value.statuses[0];
            
            await Message.findOneAndUpdate(
                { id: statusData.id },
                { status: statusData.status },
                { new: true }
            );
            console.log(`Updated status for message: ${statusData.id} to ${statusData.status}`);
        }
    }

    console.log('\nAll payloads processed successfully!');
    await mongoose.disconnect();
    console.log('MongoDB Disconnected.');
};

processFiles().catch(err => {
    console.error('A fatal error occurred during processing:', err);
    mongoose.disconnect();
});