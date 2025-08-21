import queryAPI from "../../../shared/queryAPI.js";
import extractPageInfo from "./extractPageInfo.js";
import formatRootSpans from "./formatRootSpans.js";


const fetchProject = async (api_key: string, projectName: string, lastCursor: string) => {
  try {
    console.log('Fetching root spans');
  
    const query = 
    `query GetRootSpans($projectName: String!, $lastCursor: String!) {
      projects(filter: {col: name, value: $projectName}) {
        edges {
          node {
            id
            spans(rootSpansOnly: true, first: 2000, after: $lastCursor) {
              edges {
                node {
                  context {
                    spanId
                    traceId
                  }
                  input {
                    value
                  }
                  output {
                    value
                  }
                  startTime
                  endTime
                  name
                  spanKind
                }
              }
              pageInfo {
                endCursor
                hasNextPage
              }
            }
          }
        }
      }
    }`

    const variables = {
      projectName,
      lastCursor
    };

    const data = await queryAPI(query, api_key, variables);
    const formattedData = formatRootSpans(data);
    const {endCursor, hasNextPage} = extractPageInfo(data);
    return {rootSpans: formattedData, endCursor, hasNextPage};
  } catch (error) {
    console.error('Error in fetchProject:', error);
  }
};

export default fetchProject;