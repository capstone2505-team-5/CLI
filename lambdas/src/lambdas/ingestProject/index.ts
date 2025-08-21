import { APIGatewayEvent, Context } from 'aws-lambda';
import getPhoenixKey from "../../shared/getPhoenixKey.js";
import insertRootSpans from "./lambdaRDS/insertRootSpans.js";
import createDbClient from "../../shared/createDbClient.js";
import fetchProject from './lambdaFetchRootSpans/fetchRootSpans.js';
import updateProjectCursor from './lambdaRDS/updateProjectCursor.js';

export const processProjectIngestion = async (projectName: string, lastCursor: string, context?: Context) => {
  let client;
  console.log('project name: ', projectName);
  console.log('lastCursor: ', lastCursor);

  try {
    const phoenixKey = await getPhoenixKey();

    client = await createDbClient();
    await client.connect();

    let hasNextPage = true;
    let currentCursor = lastCursor;
    let totalProcessed = 0;
    const maxIterations = 50; // Prevent infinite loops
    let iterations = 0;

    // Track start time for local timeout (5 minutes = 300000ms)
    const startTime = Date.now();
    const localTimeoutMs = 5 * 60 * 1000; // 5 minutes


    while (hasNextPage && iterations < maxIterations) {

      if (context) {
        const remainingTime = context.getRemainingTimeInMillis();
        if (remainingTime < 15000) {
          console.warn('Approaching timeout, stopping gracefully');
          if (client) await client.end();
          return { success: true, resumeCursor: currentCursor };
        }
      } else {
        // Local development - simple time check
        const elapsed = Date.now() - startTime;
        if (elapsed > localTimeoutMs) {
          console.warn('Local timeout reached (5 minutes), stopping gracefully');
          if (client) await client.end();
          return { success: true, resumeCursor: currentCursor };
        }
      }


      iterations++;
      console.log(`Fetching batch with cursor: ${currentCursor}`);
      const project = await fetchProject(phoenixKey, projectName, currentCursor);

      if (!project || project.rootSpans.length === 0) {
        console.log('No root spans found');
        break;
      }
  
      await insertRootSpans(client, project.rootSpans);
      totalProcessed += project.rootSpans.length;
  
      console.log(`Batch of ${project.rootSpans.length} root spans processed successfully`);

      currentCursor = project.endCursor || ''; // Assuming fetchProject returns endCursor
      if(currentCursor === '') break;

      if (iterations >= maxIterations) {
        console.warn(`Reached maximum iterations (${maxIterations}), stopping processing`);
      }

      //update the projects table with new last_cursor
      hasNextPage = project.hasNextPage;
      await updateProjectCursor(client, projectName, currentCursor);
    }
    
    console.log(`Total processed: ${totalProcessed} root spans`);
    return { 
      success: true, 
      rootSpans: [], // Don't return all spans, just summary
      totalProcessed,
      message: `Successfully processed ${totalProcessed} root spans` 
    };

  } catch (error: any) {
    console.error('Error in processProjectIngestion:', error);
    throw error; // Re-throw so the handler can catch and format the response
  } finally {
    if (client) {
      await client.end();
      console.log('DB client closed.');
    }
  }
};

interface CustomAPIGatewayEvent extends APIGatewayEvent {
  projectName?: string;
  lastCursor?: string;
}

export const handler = async (event: CustomAPIGatewayEvent, context: Context) => {
  let projectName = '';
  let lastCursor = '';
  console.log(event);

  try {
    projectName = event.projectName || '';
    lastCursor = event.lastCursor || '';
  } catch (parseError) {
    console.error('Error parsing request body:', parseError);
    return {
      statusCode: 400,
      body: JSON.stringify({ message: 'Invalid JSON in request body' }),
      headers: { 'Content-Type': 'application/json' }
    };
  }

  // Validate required parameters
  if (!projectName) {
    console.error('projectName not found.')
    return {
      statusCode: 400,
      body: JSON.stringify({ message: 'projectName is required' }),
      headers: { 'Content-Type': 'application/json' }
    };
  }

  try {
    const result = await processProjectIngestion(projectName, lastCursor, context);
    
    // Return success response with summary
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: result.success,
        message: result.message,
        totalProcessed: result.totalProcessed
      }),
      headers: { 'Content-Type': 'application/json' }
    };

  } catch (error: any) {
    console.error('Error in handler:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: error.message || 'Internal Server Error' }),
      headers: { 'Content-Type': 'application/json' }
    };
  }
};