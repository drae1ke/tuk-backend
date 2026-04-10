/**
 * scripts/seed-admin.js
 *
 * Creates the initial admin user in MongoDB.
 * Run once:  node scripts/seed-admin.js
 *
 * Uses environment variables from .env
 */

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// ── Admin accounts to seed ────────────────────────────────────────────────────
const ADMINS = [
  {
    name: 'TookRide Admin',
    email: 'admin@tookride.co.ke',
    phone: '254700000001',
    password: 'Admin@TookRide2024!',
    role: 'admin',
  },
  {
    name: 'Operations Manager',
    email: 'ops@tookride.co.ke',
    phone: '254700000002',
    password: 'Ops@TookRide2024!',
    role: 'admin',
  },
];

// ── Inline User model (avoids circular dependency issues in scripts) ───────────
const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    phone: { type: String, required: true, unique: true },
    password: { type: String, required: true, select: false },
    role: { type: String, enum: ['user', 'driver', 'admin'], default: 'user' },
    profilePhoto: { type: String, default: 'default-avatar.png' },
    rating: { type: Number, default: 5.0 },
    totalRides: { type: Number, default: 0 },
    savedAddresses: [],
    paymentMethods: [],
    isActive: { type: Boolean, default: true },
    emailVerified: { type: Boolean, default: true }, // admins pre-verified
    createdAt: { type: Date, default: Date.now },
    lastLogin: Date,
  },
  { timestamps: true }
);

async function main() {
  // ── Connect ──────────────────────────────────────────────────────────────────
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('❌  MONGODB_URI not set in .env');
    process.exit(1);
  }

  console.log('🔌  Connecting to MongoDB...');
  await mongoose.connect(mongoUri);
  console.log(`✅  Connected: ${mongoose.connection.host}`);

  // Use or create the model (handle hot-reload in dev)
  const User = mongoose.models.User || mongoose.model('User', userSchema);

  let created = 0;
  let skipped = 0;

  for (const admin of ADMINS) {
    const exists = await User.findOne({ email: admin.email });
    if (exists) {
      console.log(`⚠️   Already exists: ${admin.email} — skipping`);
      skipped++;
      continue;
    }

    const hashed = await bcrypt.hash(admin.password, 12);
    await User.create({ ...admin, password: hashed });
    console.log(`✅  Created admin: ${admin.email}`);
    created++;
  }

  console.log('');
  console.log('─────────────────────────────────────────');
  console.log(`  Seed complete: ${created} created, ${skipped} skipped`);
  console.log('');
  if (created > 0) {
    console.log('  Admin credentials:');
    ADMINS.forEach(a => {
      console.log(`    Email   : ${a.email}`);
      console.log(`    Password: ${a.password}`);
      console.log('');
    });
    console.log('  ⚠️  Change these passwords immediately after first login!');
  }
  console.log('─────────────────────────────────────────');

  await mongoose.connection.close();
  process.exit(0);
}

main().catch(err => {
  console.error('❌  Seed failed:', err);
  process.exit(1);
});