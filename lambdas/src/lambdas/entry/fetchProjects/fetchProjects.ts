import queryAPI from "../../../shared/queryAPI.js";
import formatProjects from "./formatProjects.js";
import { Project } from "../types/types.js";

async function fetchProjects(phoenixKey: string): Promise<Project[]> {
  console.log('Fetching all projects');

  const query = `
    query GetAllProjects {
      projects {
        edges {
          node {
            id
            name
            traceCount
            createdAt
            endTime
          }
        }
      }
    }
  `;

  const json = await queryAPI(query, phoenixKey)

  const projects = formatProjects(json);

  if (json.errors) {
    console.error("Error fetching projects:", json.errors);
    throw new Error("Failed to fetch projects");
  }

  return projects;
}

export default fetchProjects