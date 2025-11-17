import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

async function testMongoDB() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB connecté avec succès!');
    
    // Test simple
    const testDoc = await mongoose.connection.db.admin().ping();
    console.log('📊 Ping MongoDB:', testDoc);
    
    await mongoose.connection.close();
    console.log('🔌 Connexion fermée');
  } catch (error) {
    console.error('❌ Erreur MongoDB:', error);
  }
}

testMongoDB();