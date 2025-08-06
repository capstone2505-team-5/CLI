#!/usr/bin/env node
// test-module-loading.ts

console.log("🧪 Testing module loading behavior...\n");

// Add a counter to track how many times the module is loaded
let moduleLoadCount = 0;

async function testModuleLoading() {
  try {
    console.log(`📥 Loading module (attempt ${++moduleLoadCount})...`);
    
    // Import the module
    const { deployLambdaEdge } = await import('./deploy-lambda-edge');
    console.log("✅ Module loaded successfully");
    console.log("🔍 deployLambdaEdge function type:", typeof deployLambdaEdge);
    
    // Test calling with configuration
    console.log("\n📋 Testing function call with configuration...");
    await deployLambdaEdge({
      appName: "test-app",
      userPoolClientId: "test-client-id",
      userPoolDomain: "https://test.auth.us-west-2.amazoncognito.com",
      cloudFrontDomain: "test.cloudfront.net",
    });
    
    console.log("✅ Function call with configuration completed successfully");
    
    // Test calling without configuration (this should fail)
    console.log("\n📋 Testing function call without configuration...");
    try {
      await deployLambdaEdge();
      console.log("❌ Function call without configuration should have failed but didn't");
    } catch (error) {
      console.log("✅ Function call without configuration failed as expected:");
      console.log(`   Error: ${error instanceof Error ? error.message : error}`);
    }
    
    console.log("✅ Module loading test completed successfully!");
    
  } catch (error) {
    console.log(`❌ Test failed: ${error instanceof Error ? error.message : error}`);
  }
}

testModuleLoading(); 