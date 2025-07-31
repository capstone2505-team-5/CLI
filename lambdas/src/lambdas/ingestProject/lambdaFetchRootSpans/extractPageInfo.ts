import { GraphQLRootSpanResponse } from "../types/types";

const extractPageInfo = (data: GraphQLRootSpanResponse): {hasNextPage: boolean, endCursor: string} => {
  if (!data?.data?.projects?.edges) {
    console.log('No projects data found');
    return {hasNextPage: false, endCursor: ''};
  }

  const project = data.data.projects.edges[0];

  if (!project) {
    console.log('Project not found');
    return {hasNextPage: false, endCursor: ''};
  }

  if (!project?.node?.spans) {
    console.log('Spans not found');
    return {hasNextPage: false, endCursor: ''};
  }

  if (!project?.node?.spans?.pageInfo) {
    console.log('PageInfo not found');
    return {hasNextPage: false, endCursor: ''};
  }

  const { hasNextPage, endCursor } = project.node.spans.pageInfo;
  
  return {
    hasNextPage: hasNextPage || false,
    endCursor: endCursor || ''
  };
}

export default extractPageInfo;