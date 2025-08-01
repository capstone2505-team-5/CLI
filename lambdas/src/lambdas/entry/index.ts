import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { APIGatewayEvent } from "aws-lambda"
import getPhoenixKey from "../../shared/getPhoenixKey.js";
import createDbClient from "../../shared/createDbClient.js"
import fetchProjects from "./fetchProjects/fetchProjects.js";
import insertProjects from "./RDS/insertProjects.js";

const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION });

export const handler = async (event: APIGatewayEvent) => {
  let client;

  try {
    const phoenixKey = await getPhoenixKey();

    client = await createDbClient();
    await client.connect();

    let projects = await fetchProjects(phoenixKey);

    if (!projects || projects.length === 0) {
      console.log('No projects found');
      return {
        statusCode: 204, // No Content
        body: '',
        headers: {
          'Content-Type': 'application/json',
        },
      };
    }

    const projectsWithCursors = await insertProjects(client, projects);

    if(process.env.NODE_ENV === "production") {
      const invocations = projectsWithCursors.map((project) =>
        invokeProjectIngestionLambda(project.name, project.last_cursor || '')
      );

      await Promise.all(invocations);
      console.log(`Triggered ingestion for ${projects.length} projects.`);
    } else {
      const { processProjectIngestion } = await import("../ingestProject/index.js");
      const invocations = projectsWithCursors.map(async (project) => {
        try {
          const result = await processProjectIngestion(project.name, project.last_cursor || '');
          console.log(`Processed ${project.name}: ${result.message}`);
          return result;
        } catch (error) {
          console.error(`Failed to process ${project.name}:`, error);
          throw error;
        }
      });
      
      await Promise.all(invocations);

    }
    
    return {
      statusCode: 200,
      body: JSON.stringify(projects),
      headers: {
        'Content-Type': 'application/json'
      }
    };

  } catch (error: any) {
    console.error('Error in handler:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: error.message || 'Internal Server Error' }),
      headers: {
        'Content-Type': 'application/json',
      },
    };
  } finally {
    if (client) {
      await client.end();
      console.log('DB client closed.');
    }
  }
};

async function invokeProjectIngestionLambda(projectName: string, last_cursor: string) {
  const command = new InvokeCommand({
    FunctionName: process.env.SPAN_INGESTION_ARN,
    InvocationType: "Event", // async invocation
    Payload: Buffer.from(JSON.stringify({ projectName, lastCursor: last_cursor })),
  });

  try {
    await lambdaClient.send(command);
    console.log(`Triggered ingestion for project: ${projectName}`);
  } catch (err) {
    console.error(`Failed to invoke for project ${projectName}:`, err);
  }
}