export interface Project {
  id: string;
  name: string;
  createdAt: string;
  rootSpanCount: number;
  updatedAt: string;
}

export interface GraphQLProjectResponse {
  data?: {
    projects?: {
      edges?: Array<{
        node?: {
          id?: string;
          name?: string;
          createdAt?: string;
          traceCount?: number;
          endTime?: string;
          };
      }>;
    };
  };
}

export interface ProjectEdge {
  node?: {
    id?: string;
    name?: string;
    createdAt?: string;
    traceCount?: number;
    endTime?: string;
  };
}

export interface ProjectWithLastCursor {
  name: string;
  last_cursor: string | null;
}