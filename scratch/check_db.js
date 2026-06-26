const mongoose = require('mongoose');

const uri = 'mongodb+srv://praveen:praveen.2005@video-tra.vabjjlg.mongodb.net/video-transcoder?retryWrites=true&w=majority';

async function run() {
  try {
    await mongoose.connect(uri);
    const videos = mongoose.connection.collection('videos');
    
    console.log('\nRecent 15 videos:');
    const recent = await videos.find().sort({ updatedAt: -1 }).limit(15).toArray();
    recent.forEach(v => {
      console.log(`- ID: ${v.videoId}\n  Name: ${v.originalName || v.name}\n  Status: ${v.status}\n  s3Key: ${v.s3Key}\n  jobType: ${v.jobType}\n  sizeBytes: ${v.sizeBytes}\n  outputUrl: ${v.outputUrl}\n  masterPlaylistUrl: ${v.masterPlaylistUrl}\n`);
    });

  } finally {
    await mongoose.disconnect();
  }
}

run().catch(console.dir);
