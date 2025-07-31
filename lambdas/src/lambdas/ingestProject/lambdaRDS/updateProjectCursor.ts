// Helper function to update project cursor (implement as needed)
const updateProjectCursor = async (client: any, projectName: string, cursor: string) => {
  const query = `
    UPDATE projects 
    SET last_cursor = $1
    WHERE name = $2
  `;
  try {
  await client.query(query, [cursor, projectName]);
  console.log(`Updated cursor for project ${projectName} to: ${cursor}`);
  }
  catch (error){
    throw error;
  }
};

export default updateProjectCursor;