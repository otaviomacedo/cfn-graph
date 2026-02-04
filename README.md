# CloudFormation Graph Parser

A TypeScript library for parsing CloudFormation templates into graph data structures, manipulating them, and generating templates from graphs. Supports multi-stack parsing with cross-stack references via `Fn::ImportValue` and `Export`.

## Installation

```bash
npm install
npm run build
```

## Testing

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

## Features

- Parse single or multiple CloudFormation templates into a unified graph
- Automatic detection of cross-stack references (`Fn::ImportValue` and `Export`)
- Graph manipulation (add/remove nodes and edges)
- Generate CloudFormation templates from graphs
- Query dependencies, exports, and cross-stack relationships
- Full TypeScript support

## Usage

### Parse a Single CloudFormation Template

```typescript
import { CloudFormationParser } from './src/parser';

const template = {
  AWSTemplateFormatVersion: '2010-09-09',
  Resources: {
    MyBucket: {
      Type: 'AWS::S3::Bucket',
      Properties: {
        BucketName: 'my-bucket'
      }
    },
    MyQueue: {
      Type: 'AWS::SQS::Queue',
      DependsOn: 'MyBucket'
    }
  }
};

const parser = new CloudFormationParser();
const graph = parser.parse(template, 'my-stack');
```

### Parse Multiple Stacks with Cross-Stack References

```typescript
import { CloudFormationParser } from './src/parser';

const networkStack = {
  Resources: {
    VPC: {
      Type: 'AWS::EC2::VPC',
      Properties: { CidrBlock: '10.0.0.0/16' }
    }
  },
  Outputs: {
    VPCId: {
      Value: { Ref: 'VPC' },
      Export: { Name: 'NetworkStack-VPCId' }
    }
  }
};

const appStack = {
  Resources: {
    SecurityGroup: {
      Type: 'AWS::EC2::SecurityGroup',
      Properties: {
        VpcId: { 'Fn::ImportValue': 'NetworkStack-VPCId' }
      }
    }
  }
};

const parser = new CloudFormationParser();
const graph = parser.parseMultiple([
  { stackId: 'network', template: networkStack },
  { stackId: 'app', template: appStack }
]);

// Query cross-stack dependencies
const crossStackEdges = graph.getCrossStackEdges();
console.log('Cross-stack dependencies:', crossStackEdges);
```

### Manipulate the Graph

```typescript
// Add a new node
graph.addNode({
  id: 'MyTopic',
  type: 'AWS::SNS::Topic',
  properties: { TopicName: 'my-topic' }
});

// Add an edge (dependency)
graph.addEdge({
  from: 'MyQueue',
  to: 'MyTopic',
  type: EdgeType.DEPENDS_ON
});

// Remove a node
graph.removeNode('MyBucket');

// Query the graph
const dependencies = graph.getDependencies('MyQueue');
const allNodes = graph.getAllNodes();
```

### Move Nodes Between Locations

```typescript
import { createNodeId, parseNodeId } from './src';

// Move a node within the same stack (rename)
const oldId = createNodeId('storage', 'LogsBucket');
graph.moveNode(oldId, 'storage', 'AuditLogsBucket');

// Move a node to a different stack
const queueId = createNodeId('storage', 'Queue');
graph.moveNode(queueId, 'app', 'Queue');

// Move and rename in one operation
const functionId = createNodeId('app', 'Function');
graph.moveNode(functionId, 'storage', 'DataProcessor');

// Parse node IDs to get stack and logical ID
const { stackId, logicalId } = parseNodeId('storage::DataBucket');
```

### Generate Templates from Graph

```typescript
import { CloudFormationGenerator } from './src/generator';

const generator = new CloudFormationGenerator();

// Generate a single stack
const template = generator.generate(graph, 'my-stack', {
  Description: 'My CloudFormation Stack'
});

// Generate all stacks
const templates = generator.generateMultiple(graph);
for (const [stackId, template] of templates) {
  console.log(`${stackId}:`, JSON.stringify(template, null, 2));
}
```

### Query Cross-Stack Relationships

```typescript
// Get all exports
const exports = graph.getExports();
console.log('Exports:', Array.from(exports.keys()));

// Find which node exports a value
const exportNode = graph.getExportNode('NetworkStack-VPCId');

// Get all cross-stack edges
const crossStackEdges = graph.getCrossStackEdges();

// Get nodes by stack
const networkNodes = graph.getNodesByStack('network');
```

## API Reference

### CloudFormationParser

- `parse(template: CloudFormationTemplate, stackId?: string): CloudFormationGraph` - Parse a single template
- `parseMultiple(stacks: StackTemplate[]): CloudFormationGraph` - Parse multiple templates with cross-stack references

### CloudFormationGraph

- `addNode(node: GraphNode): void` - Add a node to the graph
- `removeNode(id: string): void` - Remove a node and its edges
- `getNode(id: string): GraphNode | undefined` - Get a node by ID
- `getAllNodes(): GraphNode[]` - Get all nodes
- `getNodesByStack(stackId: string): GraphNode[]` - Get nodes for a specific stack
- `addEdge(edge: GraphEdge): void` - Add an edge between nodes
- `removeEdge(from: string, to: string): void` - Remove an edge
- `getEdges(nodeId?: string): GraphEdge[]` - Get edges (optionally filtered by node)
- `getCrossStackEdges(): GraphEdge[]` - Get all cross-stack edges
- `getDependencies(nodeId: string): string[]` - Get nodes this node depends on
- `getDependents(nodeId: string): string[]` - Get nodes that depend on this node
- `registerExport(exportName: string, nodeId: string): void` - Register an export
- `getExportNode(exportName: string): string | undefined` - Get the node that exports a value
- `getExports(): Map<string, string>` - Get all exports
- `getAllStacks(): string[]` - Get all stack IDs
- `moveNode(currentId: string, newStackId: string, newLogicalId: string): void` - Move a node to a new location
- `getStackId(qualifiedId: string): string | undefined` - Get the stack ID from a qualified node ID
- `getLogicalId(qualifiedId: string): string` - Get the logical ID from a qualified node ID

### CloudFormationGenerator

- `generate(graph: CloudFormationGraph, stackId?: string, metadata?: Partial<CloudFormationTemplate>): CloudFormationTemplate` - Generate a template for a specific stack
- `generateMultiple(graph: CloudFormationGraph): Map<string, CloudFormationTemplate>` - Generate templates for all stacks

### Utility Functions

- `parseNodeId(qualifiedId: string): { stackId: string; logicalId: string }` - Parse a qualified node ID into stack and logical ID
- `createNodeId(stackId: string, logicalId: string): string` - Create a qualified node ID from stack and logical ID

## Node Movement

The `moveNode()` method allows you to relocate resources between stacks or rename them within a stack:

- **Within same stack**: Updates the logical ID (rename)
- **Across stacks**: Moves the resource to a different stack
- **Automatic edge updates**: All edges are updated to point to the new location
- **Cross-stack flag management**: Automatically updates `crossStack` flags on edges when moving between stacks
- **Export tracking**: Updates export registrations if the moved node is exported
- **Reference conversion**: When moving a resource across stacks, in-stack references (`Ref`) are automatically converted to cross-stack imports (`Fn::ImportValue`) by:
  1. Creating export nodes in the source stack for referenced resources
  2. Converting `REFERENCE` edges to `IMPORT_VALUE` edges
  3. Updating the edge to point to the export node instead of the resource directly
  4. When generating templates, `Ref` intrinsics become `Fn::ImportValue` intrinsics

Example use cases:
- Refactoring resources between stacks
- Renaming resources for better organization
- Consolidating or splitting stacks
- Reorganizing infrastructure as code

**Important**: When a resource with `Ref` dependencies is moved to another stack, the parser automatically creates the necessary exports and converts references to imports, ensuring the generated CloudFormation templates remain valid.

## License

MIT
