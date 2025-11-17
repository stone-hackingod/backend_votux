import mongoose from 'mongoose';

const ballotSchema = new mongoose.Schema({
  electionId: {
    type: String,
    required: true,
    index: true
  },
  encryptedVote: {
    type: String,
    required: true
  },
  voteHash: {
    type: String,
    required: true,
    unique: true
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// CORRECTION : Ne bloquer que les modifications, pas la création
ballotSchema.pre('save', function(next) {
  // Si le document existe déjà (modification) et n'est pas nouveau
  if (this.isNew === false && this.isModified()) {
    return next(new Error('Les bulletins de vote ne peuvent pas être modifiés'));
  }
  next();
});

// Alternative plus simple - Supprimer complètement le middleware
// ballotSchema.pre('save', function(next) {
//   next();
// });

export default mongoose.model('Ballot', ballotSchema);