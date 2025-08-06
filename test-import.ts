#!/usr/bin/env node
// test-import.ts

async function testImport() {
  console.log("🧪 Testing import behavior of deploy-lambda-edge...\n");

  try {
    console.log("📥 Importing deployLambdaEdge function...");
    const { deployLambdaEdge } = await import('./deploy-lambda-edge');
    console.log("✅ Successfully imported deployLambdaEdge function");
    console.log("🔍 deployLambdaEdge function type:", typeof deployLambdaEdge);
    
    console.log("\n📋 Testing function call with configuration...");
    await deployLambdaEdge({
      appName: "test-app",
      userPoolClientId: "test-client-id",
      userPoolDomain: "https://test.auth.us-west-2.amazoncognito.com",
      cloudFrontDomain: "test.cloudfront.net",
    });
    
    console.log("✅ Import and function call test completed successfully!");
    
  } catch (error) {
    console.log(`❌ Test failed: ${error instanceof Error ? error.message : error}`);
  }
}

testImport(); 