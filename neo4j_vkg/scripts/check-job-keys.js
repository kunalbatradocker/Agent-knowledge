/**
 * Script to check and clean up orphaned ontology job keys in Redis
 */
const { createClient } = require('redis');

async function check() {
  const client = createClient({ url: 'redis://localhost:6379' });
  await client.connect();
  
  // Get all ontology_job keys
  const jobKeys = await client.keys('ontology_job:*');
  console.log('=== All ontology_job:* keys ===');
  console.log(jobKeys);
  
  // Get job list sets
  const allJobs = await client.sMembers('ontology_jobs:all');
  console.log('\n=== ontology_jobs:all set ===');
  console.log(allJobs);
  
  // Get workspace-specific sets
  const wsKeys = await client.keys('ontology_jobs:workspace:*');
  console.log('\n=== Workspace job sets ===');
  for (const key of wsKeys) {
    const members = await client.sMembers(key);
    console.log(key + ':', members);
  }
  
  // Check all jobs' data
  console.log('\n=== All jobs data ===');
  for (const key of jobKeys) {
    if (key.includes('file:')) continue;
    const data = await client.hGetAll(key);
    console.log(`\n${key}:`);
    console.log(`  workspace_id: "${data.workspace_id}" (${typeof data.workspace_id})`);
    console.log(`  status: ${data.status}`);
    console.log(`  file_name: ${data.file_name}`);
  }
  
  await client.quit();
}

async function cleanup() {
  const client = createClient({ url: 'redis://localhost:6379' });
  await client.connect();
  
  console.log('\n🧹 Cleaning up orphaned job keys...\n');
  
  // Get all job keys
  const jobKeys = await client.keys('ontology_job:*');
  const jobHashKeys = jobKeys.filter(k => !k.includes('file:'));
  
  let deleted = 0;
  for (const key of jobHashKeys) {
    const jobId = key.replace('ontology_job:', '');
    
    // Delete the hash
    await client.del(key);
    
    // Remove from all set
    await client.sRem('ontology_jobs:all', jobId);
    
    // Remove from any workspace sets
    const wsKeys = await client.keys('ontology_jobs:workspace:*');
    for (const wsKey of wsKeys) {
      await client.sRem(wsKey, jobId);
    }
    
    console.log(`  🗑️ Deleted: ${jobId}`);
    deleted++;
  }
  
  console.log(`\n✅ Deleted ${deleted} orphaned job keys`);
  
  await client.quit();
}

const args = process.argv.slice(2);
if (args.includes('--cleanup')) {
  cleanup().catch(console.error);
} else {
  check().catch(console.error);
  console.log('\n💡 Run with --cleanup to delete all orphaned jobs');
}
