import { GraphQLRootSpanResponse, RootSpan, ProjectEdge, SpanEdge } from "../types/types";

const formatRootSpans = (data: GraphQLRootSpanResponse): RootSpan[] => {
  try {
    // Parse json and format by spanKind
    const allSpans = parseAndFormatSpans(data);

    // Filter out spans with any missing properties
    const filteredSpans = filterSpans(allSpans); 

    // console.log(`📈 Processed ${filteredSpans.length} valid root spans`);
    return filteredSpans;

  } catch (error) {
    console.error('Error in formatRootSpans:', error);
    return []; // Return empty array on any formatting error
  }
};

const parseAndFormatSpans = (data: GraphQLRootSpanResponse): (RootSpan | null)[] => {
  if (!data?.data?.projects?.edges) {
    console.log('No projects data found');
    return [];
  }

  const project = data.data.projects.edges[0];

  if (!project) {
    console.log('Project not found');
    return [];
  }

  if (!project?.node?.spans?.edges) {
    console.log('No spans found for project:', project?.node?.id);
    return [];
  }

  const projectId = project?.node?.id;
  if (!projectId) {
    console.warn('Project missing id, skipping');
    return [];
  }

  return project.node.spans.edges.map((span: SpanEdge) => {
    try {
      const spanNode = span?.node;
      if (!spanNode) {
        console.warn('Span node is missing, skipping');
        return null;
      }

      const context = spanNode?.context;
      if (!context?.spanId || !context?.traceId) {
        console.warn('Span missing required context (spanId/traceId), skipping');
        return null;
      }

      // console.log('🚀 Processing span:', context.spanId);
      // console.log('📊 Raw span data:', {
      //   spanKind: spanNode?.spanKind,
      //   inputValue: spanNode?.input?.value?.substring(0, 100) + '...',
      //   outputValue: spanNode?.output?.value?.substring(0, 100) + '...',
      //   inputType: typeof spanNode?.input?.value,
      //   outputType: typeof spanNode?.output?.value
      // });
      
      // Use safeJsonParse instead of inline JSON.parse
      const inputValue = spanNode?.input?.value;
      const outputValue = spanNode?.output?.value;
      
      // console.log('🔧 Before parsing - Input value:', typeof inputValue, inputValue?.substring(0, 200));
      // console.log('🔧 Before parsing - Output value:', typeof outputValue, outputValue?.substring(0, 200));
      
      const inputContent = safeJsonParse(inputValue);
      const outputContent = safeJsonParse(outputValue);
      
      // console.log('✨ After parsing - Input content:', typeof inputContent, inputContent);
      // console.log('✨ After parsing - Output content:', typeof outputContent, outputContent);
      
      // Apply span kind specific formatting
      const spanKind = spanNode?.spanKind || null;
      // console.log('🏷️ Span kind before formatter:', spanKind);
      
      const formattedContent = spanKindFormatter(spanKind, inputContent, outputContent);
      
      // console.log('🎯 Final formatted content:', {
      //   input: typeof formattedContent.input,
      //   output: typeof formattedContent.output,
      //   inputPreview: typeof formattedContent.input === 'string' ? formattedContent.input.substring(0, 100) : formattedContent.input
      // });
      
      return {
        id: context.spanId,
        traceId: context.traceId,
        startTime: spanNode?.startTime || null,
        endTime: spanNode?.endTime || null,
        input: formattedContent.input,
        output: formattedContent.output,
        projectId,
        spanName: spanNode?.name || null,
      };
    } catch (spanError) {
      console.error('Error processing individual span:', spanError);
      return null; // Return null for failed spans
    }
  });
}

  const filterSpans = (allSpans: (RootSpan | null)[]): RootSpan[] => {
    return allSpans.filter((rootSpan: (RootSpan | null)): rootSpan is RootSpan => {
      if (rootSpan === null) {
        return false; // Filter out failed spans
      }
      
      const valid = isValidRootSpan(rootSpan);
      if (!valid) {
        console.warn('Filtered out incomplete span:', {
          id: rootSpan?.id,
          hasInput: rootSpan?.input !== null && rootSpan?.input !== undefined,
          hasOutput: rootSpan?.output !== null && rootSpan?.output !== undefined,
          hasStartTime: !!rootSpan?.startTime,
          hasEndTime: !!rootSpan?.endTime,
          hasSpanName: !!rootSpan?.spanName,
        });
      }
      return valid;
    });
  }

function safeJsonParse(value: string | null | undefined): any {
  if (!value || typeof value !== 'string') {
    return value; // Return as-is if not a string
  }
  
  try {
    return JSON.parse(value);
  } catch {
    return value; // Return original string if parsing fails
  }
}

const spanKindFormatter = (spanKind: string | null, inputContent: any, outputContent: any) => {
  // console.log('🔍 spanKindFormatter called with:', {
  //   spanKind,
  //   inputContentType: typeof inputContent,
  //   outputContentType: typeof outputContent,
  //   inputPreview: typeof inputContent === 'string' ? inputContent.substring(0, 100) + '...' : inputContent
  // });

  if (spanKind === "llm") {
    // console.log('📝 Processing LLM span');
    
    // Format input: extract the content from the last message
    let formattedInput = inputContent;
    
    if (inputContent && typeof inputContent === 'object' && inputContent.messages && Array.isArray(inputContent.messages)) {
      // console.log('✅ Found input messages array with', inputContent.messages.length, 'messages');
      const messages = inputContent.messages;
      if (messages.length > 0) {
        const lastMessage = messages[messages.length - 1];
        // console.log('📄 Last input message:', lastMessage);
        if (lastMessage && lastMessage.content) {
          formattedInput = lastMessage.content;
          // console.log('✅ Extracted content from last input message');
        } else {
          // console.log('⚠️ Last input message has no content property');
        }
      }
    } else {
      // console.log('❌ Input is not an object with messages array. Input structure:', {
      //   isObject: typeof inputContent === 'object',
      //   hasMessages: inputContent?.messages !== undefined,
      //   messagesIsArray: Array.isArray(inputContent?.messages)
      // });
    }

    // Format output: extract choices[0].message.content from OpenAI response
    let formattedOutput = outputContent;
    
    if (outputContent && typeof outputContent === 'object' && outputContent.choices && Array.isArray(outputContent.choices)) {
      // console.log('✅ Found output choices array with', outputContent.choices.length, 'choices');
      if (outputContent.choices.length > 0) {
        const firstChoice = outputContent.choices[0];
        // console.log('📄 First choice:', firstChoice);
        if (firstChoice && firstChoice.message && firstChoice.message.content) {
          formattedOutput = firstChoice.message.content;
          // console.log('✅ Extracted content from first choice message');
        } else {
          // console.log('⚠️ First choice missing message.content structure:', {
          //   hasMessage: !!firstChoice?.message,
          //   hasContent: !!firstChoice?.message?.content
          // });
        }
      }
    } else {
      // console.log('❌ Output is not an object with choices array. Output structure:', {
      //   isObject: typeof outputContent === 'object',
      //   hasChoices: outputContent?.choices !== undefined,
      //   choicesIsArray: Array.isArray(outputContent?.choices)
      // });
    }
    
    return {
      input: formattedInput,
      output: formattedOutput
    };
  } else if (spanKind === "chain") {
    // console.log('⛓️ Processing Chain span');
    
    // Format input: extract content from the last object in the messages array
    let formattedInput = inputContent;
    
    if (inputContent && typeof inputContent === 'object' && inputContent.messages && Array.isArray(inputContent.messages)) {
      // console.log('✅ Found input messages array with', inputContent.messages.length, 'messages');
      const messages = inputContent.messages;
      if (messages.length > 0) {
        const lastMessage = messages[messages.length - 1];
        // console.log('📄 Last input message:', lastMessage);
        if (lastMessage && lastMessage.content) {
          formattedInput = lastMessage.content;
          // console.log('✅ Extracted content from last input message');
        } else {
          // console.log('⚠️ Last input message has no content property');
        }
      }
    } else {
      // console.log('❌ Input is not an object with messages array. Input structure:', {
      //   isObject: typeof inputContent === 'object',
      //   hasMessages: inputContent?.messages !== undefined,
      //   messagesIsArray: Array.isArray(inputContent?.messages)
      // });
    }

    // Format output: extract content from the last object in the messages array (same as input)
    let formattedOutput = outputContent;
    
    if (outputContent && typeof outputContent === 'object' && outputContent.messages && Array.isArray(outputContent.messages)) {
      // console.log('✅ Found output messages array with', outputContent.messages.length, 'messages');
      const messages = outputContent.messages;
      if (messages.length > 0) {
        const lastMessage = messages[messages.length - 1];
        // console.log('📄 Last output message:', lastMessage);
        if (lastMessage && lastMessage.content) {
          formattedOutput = lastMessage.content;
          // console.log('✅ Extracted content from last output message');
        } else {
          // console.log('⚠️ Last output message has no content property');
        }
      }
    } else {
      // console.log('❌ Output is not an object with messages array. Output structure:', {
      //   isObject: typeof outputContent === 'object',
      //   hasMessages: outputContent?.messages !== undefined,
      //   messagesIsArray: Array.isArray(outputContent?.messages)
      // });
    }

    return {
      input: formattedInput,
      output: formattedOutput
    };
  } else if (spanKind === "agent") {
    // console.log('🤖 Processing Agent span');
    
    // Format input: extract content from the last object in the array
    let formattedInput = inputContent;
    
    if (inputContent && Array.isArray(inputContent)) {
      // console.log('✅ Found input array with', inputContent.length, 'items');
      if (inputContent.length > 0) {
        const lastItem = inputContent[inputContent.length - 1];
        // console.log('📄 Last input item:', lastItem);
        if (lastItem && lastItem.content) {
          formattedInput = lastItem.content;
          // console.log('✅ Extracted content from last input item');
        } else {
          // console.log('⚠️ Last input item has no content property');
        }
      }
    } else {
      // console.log('❌ Input is not an array. Input structure:', {
      //   isArray: Array.isArray(inputContent),
      //   inputType: typeof inputContent
      // });
    }

    // Format output: extract content from the last object in the array (same as input)
    let formattedOutput = outputContent;
    
    if (outputContent && Array.isArray(outputContent)) {
      // console.log('✅ Found output array with', outputContent.length, 'items');
      if (outputContent.length > 0) {
        const lastItem = outputContent[outputContent.length - 1];
        // console.log('📄 Last output item:', lastItem);
        if (lastItem && lastItem.content) {
          formattedOutput = lastItem.content;
          // console.log('✅ Extracted content from last output item');
        } else {
          // console.log('⚠️ Last output item has no content property');
        }
      }
    } else {
      // console.log('❌ Output is not an array. Output structure:', {
      //   isArray: Array.isArray(outputContent),
      //   outputType: typeof outputContent
      // });
    }

    return {
      input: formattedInput,
      output: formattedOutput
    };
  } else {
    // console.log('📋 Processing Uknown Kind span, returning as-is');
  }
  
  // For spans with no spanKind, return as-is
  return {
    input: inputContent,
    output: outputContent
  };
};

const isValidRootSpan = (rootSpan: any): boolean => {
  const requiredProps = ['id', 'traceId', 'startTime', 'endTime', 'input', 'output', 'projectId', 'spanName'];
  
  return requiredProps.every(prop => {
    const value = rootSpan[prop];
    return value !== null && value !== undefined && value !== '';
  });
};

export default formatRootSpans;