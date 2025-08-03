import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Mock API Lambda invoked');
  console.log('Event:', JSON.stringify(event, null, 2));

  // Extract user information from Cognito authorizer
  const userInfo = event.requestContext.authorizer?.claims || {};
  
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    },
    body: JSON.stringify({
      message: 'Mock API endpoint working!',
      timestamp: new Date().toISOString(),
      user: {
        sub: userInfo.sub || 'unknown',
        email: userInfo.email || 'unknown',
        username: userInfo['cognito:username'] || 'unknown',
      },
      request: {
        method: event.httpMethod,
        path: event.path,
        queryParams: event.queryStringParameters || {},
      },
      note: 'This is a mock endpoint. Replace with real API logic in the future.',
    }),
  };
}; 