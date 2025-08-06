#!/usr/bin/env node
// check-outputs.js

const { execSync } = require('child_process');

const stackName = 'alex-auth-test11-stack';
const profile = 'capstone-profile';
const region = 'us-west-2';

try {
  console.log(`🔍 Checking outputs for stack: ${stackName}`);
  console.log(`👤 Profile: ${profile}`);
  console.log(`🌎 Region: ${region}\n`);
  
  const command = `aws cloudformation describe-stacks --stack-name ${stackName} --profile ${profile} --region ${region} --query 'Stacks[0].Outputs' --output json`;
  console.log(`Running: ${command}`);
  
  const output = execSync(command, { encoding: 'utf8' });
  const outputs = JSON.parse(output);
  
  console.log(`📊 Found ${outputs.length} outputs:`);
  outputs.forEach(output => {
    console.log(`   - ${output.OutputKey}: ${output.OutputValue}`);
  });
  
  // Check for required outputs
  const requiredOutputs = ['UserPoolClientId', 'UserPoolDomain', 'CloudFrontDomain', 'CloudFrontDistributionId'];
  const missingOutputs = requiredOutputs.filter(key => !outputs.find(o => o.OutputKey === key));
  
  if (missingOutputs.length === 0) {
    console.log("\n✅ All required outputs found!");
  } else {
    console.log("\n❌ Missing required outputs:");
    missingOutputs.forEach(key => console.log(`   - ${key}`));
  }
  
} catch (error) {
  console.log(`❌ Error: ${error.message}`);
} 