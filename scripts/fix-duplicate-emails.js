import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

await mongoose.connect(process.env.MONGODB_URI);

const duplicates = await mongoose.connection.db.collection('loginemails').aggregate([
  { $sort: { createdAt: -1 } }, // latest pehle
  { $group: { _id: '$email', ids: { $push: '$_id' }, count: { $sum: 1 } } },
  { $match: { count: { $gt: 1 } } }
]).toArray();

let deleted = 0;
for (const doc of duplicates) {
  doc.ids.shift(); // latest rakho, baaki delete
  const result = await mongoose.connection.db.collection('loginemails').deleteMany({ _id: { $in: doc.ids } });
  deleted += result.deletedCount;
}

console.log(`✅ Done. Removed ${deleted} duplicate email records.`);
await mongoose.disconnect();
