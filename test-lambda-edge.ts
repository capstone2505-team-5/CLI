#!/usr/bin/env node
// test-lambda-edge.ts

import { deployLambdaEdge } from './deploy-lambda-edge';

async function testLambdaEdgeDeployment() {
  console.log("🧪 Testing Lambda@Edge deployment with mock configuration...\n");
  
  const mockConfig = {
    appName: "test-app",
    userPoolClientId: "test-client-id",
    userPoolDomain: "https://test.auth.us-west-2.amazoncognito.com",
    cloudFrontDomain: "test.cloudfront.net",
  };
  
  console.log("📋 Mock configuration:");
  console.log(`   App Name: ${mockConfig.appName}`);
  console.log(`   User Pool Client ID: ${mockConfig.userPoolClientId}`);
  console.log(`   User Pool Domain: ${mockConfig.userPoolDomain}`);
  console.log(`   CloudFront Domain: ${mockConfig.cloudFrontDomain}`);
  
  try {
    await deployLambdaEdge(mockConfig);
    console.log("✅ Test completed successfully!");
  } catch (error) {
    console.log(`❌ Test failed: ${error instanceof Error ? error.message : error}`);
  }
}

// Run if executed directly
if (require.main === module) {
  testLambdaEdgeDeployment().catch(console.error);
} 