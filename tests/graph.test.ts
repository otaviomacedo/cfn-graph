import { CloudFormationGraph } from '../src/graph';
import { GraphNode, EdgeType } from '../src/types';

describe('CloudFormationGraph', () => {
  let graph: CloudFormationGraph;

  beforeEach(() => {
    graph = new CloudFormationGraph();
  });

  describe('Node Operations', () => {
    test('should add a node', () => {
      const node: GraphNode = {
        id: 'stack1.Bucket',
        type: 'AWS::S3::Bucket',
        properties: { BucketName: 'test-bucket' },
        stackId: 'stack1'
      };

      graph.addNode(node);
      expect(graph.getNode('stack1.Bucket')).toEqual(node);
    });

    test('should get all nodes', () => {
      const node1: GraphNode = {
        id: 'stack1.Bucket',
        type: 'AWS::S3::Bucket',
        properties: {},
        stackId: 'stack1'
      };
      const node2: GraphNode = {
        id: 'stack1.Queue',
        type: 'AWS::SQS::Queue',
        properties: {},
        stackId: 'stack1'
      };

      graph.addNode(node1);
      graph.addNode(node2);

      const nodes = graph.getAllNodes();
      expect(nodes).toHaveLength(2);
      expect(nodes).toContainEqual(node1);
      expect(nodes).toContainEqual(node2);
    });

    test('should remove a node', () => {
      const node: GraphNode = {
        id: 'stack1.Bucket',
        type: 'AWS::S3::Bucket',
        properties: {},
        stackId: 'stack1'
      };

      graph.addNode(node);
      graph.removeNode('stack1.Bucket');
      expect(graph.getNode('stack1.Bucket')).toBeUndefined();
    });

    test('should get nodes by stack', () => {
      const node1: GraphNode = {
        id: 'stack1.Bucket',
        type: 'AWS::S3::Bucket',
        properties: {},
        stackId: 'stack1'
      };
      const node2: GraphNode = {
        id: 'stack2.Queue',
        type: 'AWS::SQS::Queue',
        properties: {},
        stackId: 'stack2'
      };

      graph.addNode(node1);
      graph.addNode(node2);

      const stack1Nodes = graph.getNodesByStack('stack1');
      expect(stack1Nodes).toHaveLength(1);
      expect(stack1Nodes[0]).toEqual(node1);
    });

    test('should get all stacks', () => {
      const node1: GraphNode = {
        id: 'stack1.Bucket',
        type: 'AWS::S3::Bucket',
        properties: {},
        stackId: 'stack1'
      };
      const node2: GraphNode = {
        id: 'stack2.Queue',
        type: 'AWS::SQS::Queue',
        properties: {},
        stackId: 'stack2'
      };

      graph.addNode(node1);
      graph.addNode(node2);

      const stacks = graph.getAllStacks();
      expect(stacks).toHaveLength(2);
      expect(stacks).toContain('stack1');
      expect(stacks).toContain('stack2');
    });
  });

  describe('Edge Operations', () => {
    beforeEach(() => {
      const node1: GraphNode = {
        id: 'stack1::Bucket',
        type: 'AWS::S3::Bucket',
        properties: {},
        stackId: 'stack1'
      };
      const node2: GraphNode = {
        id: 'stack1::Queue',
        type: 'AWS::SQS::Queue',
        properties: {},
        stackId: 'stack1'
      };

      graph.addNode(node1);
      graph.addNode(node2);
    });

    test('should add an edge', () => {
      graph.addEdge({
        from: 'stack1::Queue',
        to: 'stack1::Bucket',
        type: EdgeType.DEPENDS_ON
      });

      const edges = graph.getEdges('stack1::Queue');
      expect(edges).toHaveLength(1);
      expect(edges[0]).toMatchObject({
        from: 'stack1::Queue',
        to: 'stack1::Bucket',
        type: EdgeType.DEPENDS_ON
      });
    });

    test('should throw error when adding edge with non-existent nodes', () => {
      expect(() => {
        graph.addEdge({
          from: 'stack1::NonExistent',
          to: 'stack1::Bucket',
          type: EdgeType.DEPENDS_ON
        });
      }).toThrow();
    });

    test('should remove an edge', () => {
      graph.addEdge({
        from: 'stack1::Queue',
        to: 'stack1::Bucket',
        type: EdgeType.DEPENDS_ON
      });

      graph.removeEdge('stack1::Queue', 'stack1::Bucket');
      const edges = graph.getEdges('stack1::Queue');
      expect(edges).toHaveLength(0);
    });

    test('should get all edges', () => {
      graph.addEdge({
        from: 'stack1::Queue',
        to: 'stack1::Bucket',
        type: EdgeType.DEPENDS_ON
      });

      const allEdges = graph.getEdges();
      expect(allEdges).toHaveLength(1);
    });

    test('should get dependencies', () => {
      graph.addEdge({
        from: 'stack1::Queue',
        to: 'stack1::Bucket',
        type: EdgeType.DEPENDS_ON
      });

      const deps = graph.getDependencies('stack1::Queue');
      expect(deps).toEqual(['stack1::Bucket']);
    });

    test('should get dependents', () => {
      graph.addEdge({
        from: 'stack1::Queue',
        to: 'stack1::Bucket',
        type: EdgeType.DEPENDS_ON
      });

      const dependents = graph.getDependents('stack1::Bucket');
      expect(dependents).toEqual(['stack1::Queue']);
    });

    test('should get cross-stack edges', () => {
      const node3: GraphNode = {
        id: 'stack2::Topic',
        type: 'AWS::SNS::Topic',
        properties: {},
        stackId: 'stack2'
      };
      graph.addNode(node3);

      graph.addEdge({
        from: 'stack1::Queue',
        to: 'stack1::Bucket',
        type: EdgeType.DEPENDS_ON,
        crossStack: false
      });

      graph.addEdge({
        from: 'stack1::Queue',
        to: 'stack2::Topic',
        type: EdgeType.IMPORT_VALUE,
        crossStack: true
      });

      const crossStackEdges = graph.getCrossStackEdges();
      expect(crossStackEdges).toHaveLength(1);
      expect(crossStackEdges[0].crossStack).toBe(true);
    });
  });

  describe('Export Operations', () => {
    test('should register an export', () => {
      const node: GraphNode = {
        id: 'stack1::Export::VPC',
        type: 'AWS::CloudFormation::Export',
        properties: { Name: 'MyVPC' },
        stackId: 'stack1'
      };

      graph.addNode(node);
      graph.registerExport('MyVPC', 'stack1::Export::VPC');

      expect(graph.getExportNode('MyVPC')).toBe('stack1::Export::VPC');
    });

    test('should get all exports', () => {
      const node1: GraphNode = {
        id: 'stack1.Export.VPC',
        type: 'AWS::CloudFormation::Export',
        properties: { Name: 'MyVPC' },
        stackId: 'stack1'
      };
      const node2: GraphNode = {
        id: 'stack1.Export.Subnet',
        type: 'AWS::CloudFormation::Export',
        properties: { Name: 'MySubnet' },
        stackId: 'stack1'
      };

      graph.addNode(node1);
      graph.addNode(node2);
      graph.registerExport('MyVPC', 'stack1.Export.VPC');
      graph.registerExport('MySubnet', 'stack1.Export.Subnet');

      const exports = graph.getExports();
      expect(exports.size).toBe(2);
      expect(exports.get('MyVPC')).toBe('stack1.Export.VPC');
      expect(exports.get('MySubnet')).toBe('stack1.Export.Subnet');
    });

    test('should remove export when node is removed', () => {
      const node: GraphNode = {
        id: 'stack1.Export.VPC',
        type: 'AWS::CloudFormation::Export',
        properties: { Name: 'MyVPC' },
        stackId: 'stack1'
      };

      graph.addNode(node);
      graph.registerExport('MyVPC', 'stack1.Export.VPC');
      graph.removeNode('stack1.Export.VPC');

      expect(graph.getExportNode('MyVPC')).toBeUndefined();
    });
  });

  describe('Node Movement', () => {
    beforeEach(() => {
      const node1: GraphNode = {
        id: 'stack1.Bucket',
        type: 'AWS::S3::Bucket',
        properties: { BucketName: 'test' },
        stackId: 'stack1'
      };
      const node2: GraphNode = {
        id: 'stack1.Queue',
        type: 'AWS::SQS::Queue',
        properties: {},
        stackId: 'stack1'
      };

      graph.addNode(node1);
      graph.addNode(node2);
    });

    test('should rename node within same stack', () => {
      graph.moveNode('stack1.Bucket', 'stack1', 'DataBucket');

      expect(graph.getNode('stack1.Bucket')).toBeUndefined();
      expect(graph.getNode('stack1.DataBucket')).toBeDefined();
      expect(graph.getNode('stack1.DataBucket')?.type).toBe('AWS::S3::Bucket');
    });

    test('should move node to different stack', () => {
      graph.moveNode('stack1.Bucket', 'stack2', 'Bucket');

      expect(graph.getNode('stack1.Bucket')).toBeUndefined();
      expect(graph.getNode('stack2.Bucket')).toBeDefined();
      expect(graph.getNode('stack2.Bucket')?.stackId).toBe('stack2');
    });

    test('should update edges when moving node', () => {
      graph.addEdge({
        from: 'stack1.Queue',
        to: 'stack1.Bucket',
        type: EdgeType.DEPENDS_ON
      });

      graph.moveNode('stack1.Bucket', 'stack2', 'Bucket');

      const edges = graph.getEdges('stack1.Queue');
      expect(edges[0].to).toBe('stack2.Bucket');
      expect(edges[0].crossStack).toBe(true);
    });

    test('should throw error when target location exists', () => {
      expect(() => {
        graph.moveNode('stack1.Bucket', 'stack1', 'Queue');
      }).toThrow('Target location stack1.Queue already exists');
    });

    test('should throw error when node does not exist', () => {
      expect(() => {
        graph.moveNode('stack1.NonExistent', 'stack2', 'Test');
      }).toThrow('Node stack1.NonExistent does not exist');
    });

    test('should convert in-stack reference to cross-stack import', () => {
      const topic: GraphNode = {
        id: 'stack1.Topic',
        type: 'AWS::SNS::Topic',
        properties: {},
        stackId: 'stack1'
      };
      const subscription: GraphNode = {
        id: 'stack1.Subscription',
        type: 'AWS::SNS::Subscription',
        properties: { TopicArn: { Ref: 'Topic' } },
        stackId: 'stack1'
      };

      graph.addNode(topic);
      graph.addNode(subscription);
      graph.addEdge({
        from: 'stack1.Subscription',
        to: 'stack1.Topic',
        type: EdgeType.REFERENCE
      });

      // Move subscription to different stack
      graph.moveNode('stack1.Subscription', 'stack2', 'Subscription');

      // Check that export was created
      const exportNode = graph.getNode('stack1.Export.Topic');
      expect(exportNode).toBeDefined();
      expect(exportNode?.type).toBe('AWS::CloudFormation::Export');

      // Check that edge was converted to IMPORT_VALUE
      const edges = graph.getEdges('stack2.Subscription');
      const importEdge = edges.find(e => e.type === EdgeType.IMPORT_VALUE);
      expect(importEdge).toBeDefined();
      expect(importEdge?.crossStack).toBe(true);
    });

    test('should update export registrations when moving exported node', () => {
      graph.registerExport('MyBucket', 'stack1.Bucket');
      graph.moveNode('stack1.Bucket', 'stack2', 'Bucket');

      expect(graph.getExportNode('MyBucket')).toBe('stack2.Bucket');
    });
  });

  describe('Utility Methods', () => {
    test('should get stack ID from qualified ID', () => {
      const node: GraphNode = {
        id: 'stack1::Bucket',
        type: 'AWS::S3::Bucket',
        properties: {},
        stackId: 'stack1'
      };

      graph.addNode(node);
      expect(graph.getStackId('stack1::Bucket')).toBe('stack1');
    });

    test('should get logical ID from qualified ID', () => {
      expect(graph.getLogicalId('stack1.Bucket')).toBe('Bucket');
      expect(graph.getLogicalId('stack1.Export.VPC')).toBe('Export.VPC');
    });
  });

  describe('Topological Sort', () => {
    test('should return nodes in topological order', () => {
      const bucket: GraphNode = {
        id: 'stack1::Bucket',
        type: 'AWS::S3::Bucket',
        properties: {},
        stackId: 'stack1'
      };
      const queue: GraphNode = {
        id: 'stack1::Queue',
        type: 'AWS::SQS::Queue',
        properties: {},
        stackId: 'stack1'
      };
      const topic: GraphNode = {
        id: 'stack1::Topic',
        type: 'AWS::SNS::Topic',
        properties: {},
        stackId: 'stack1'
      };

      graph.addNode(bucket);
      graph.addNode(queue);
      graph.addNode(topic);

      graph.addEdge({ from: 'stack1::Queue', to: 'stack1::Bucket', type: EdgeType.DEPENDS_ON });
      graph.addEdge({ from: 'stack1::Topic', to: 'stack1::Queue', type: EdgeType.DEPENDS_ON });

      const sorted = graph.getAllNodesSorted();
      const ids = sorted.map(n => n.id);

      expect(ids.indexOf('stack1::Bucket')).toBeLessThan(ids.indexOf('stack1::Queue'));
      expect(ids.indexOf('stack1::Queue')).toBeLessThan(ids.indexOf('stack1::Topic'));
    });

    test('should handle nodes with no dependencies', () => {
      const bucket: GraphNode = {
        id: 'stack1::Bucket',
        type: 'AWS::S3::Bucket',
        properties: {},
        stackId: 'stack1'
      };
      const queue: GraphNode = {
        id: 'stack1::Queue',
        type: 'AWS::SQS::Queue',
        properties: {},
        stackId: 'stack1'
      };

      graph.addNode(bucket);
      graph.addNode(queue);

      const sorted = graph.getAllNodesSorted();
      expect(sorted).toHaveLength(2);
    });

    test('should throw error on circular dependency', () => {
      const bucket: GraphNode = {
        id: 'stack1::Bucket',
        type: 'AWS::S3::Bucket',
        properties: {},
        stackId: 'stack1'
      };
      const queue: GraphNode = {
        id: 'stack1::Queue',
        type: 'AWS::SQS::Queue',
        properties: {},
        stackId: 'stack1'
      };

      graph.addNode(bucket);
      graph.addNode(queue);

      graph.addEdge({ from: 'stack1::Queue', to: 'stack1::Bucket', type: EdgeType.DEPENDS_ON });
      graph.addEdge({ from: 'stack1::Bucket', to: 'stack1::Queue', type: EdgeType.DEPENDS_ON });

      expect(() => graph.getAllNodesSorted()).toThrow('Circular dependency detected');
    });
  });

  describe('Graph Reversal', () => {
    test('should reverse edge directions', () => {
      const bucket: GraphNode = {
        id: 'stack1::Bucket',
        type: 'AWS::S3::Bucket',
        properties: {},
        stackId: 'stack1'
      };
      const queue: GraphNode = {
        id: 'stack1::Queue',
        type: 'AWS::SQS::Queue',
        properties: {},
        stackId: 'stack1'
      };

      graph.addNode(bucket);
      graph.addNode(queue);
      graph.addEdge({ from: 'stack1::Queue', to: 'stack1::Bucket', type: EdgeType.DEPENDS_ON });

      const reversed = graph.opposite();
      const edges = reversed.getEdges();

      expect(edges).toHaveLength(1);
      expect(edges[0].from).toBe('stack1::Bucket');
      expect(edges[0].to).toBe('stack1::Queue');
      expect(edges[0].type).toBe(EdgeType.DEPENDS_ON);
    });

    test('should preserve all nodes', () => {
      const bucket: GraphNode = {
        id: 'stack1::Bucket',
        type: 'AWS::S3::Bucket',
        properties: {},
        stackId: 'stack1'
      };
      const queue: GraphNode = {
        id: 'stack1::Queue',
        type: 'AWS::SQS::Queue',
        properties: {},
        stackId: 'stack1'
      };

      graph.addNode(bucket);
      graph.addNode(queue);

      const reversed = graph.opposite();

      expect(reversed.getAllNodes()).toHaveLength(2);
      expect(reversed.getNode('stack1::Bucket')).toEqual(bucket);
      expect(reversed.getNode('stack1::Queue')).toEqual(queue);
    });

    test('should preserve exports', () => {
      const exportNode: GraphNode = {
        id: 'stack1::Export::VPC',
        type: 'AWS::CloudFormation::Export',
        properties: { Name: 'MyVPC' },
        stackId: 'stack1'
      };

      graph.addNode(exportNode);
      graph.registerExport('MyVPC', 'stack1::Export::VPC');

      const reversed = graph.opposite();

      expect(reversed.getExportNode('MyVPC')).toBe('stack1::Export::VPC');
      expect(reversed.getExports().size).toBe(1);
    });

    test('should reverse dependencies and dependents', () => {
      const bucket: GraphNode = {
        id: 'stack1::Bucket',
        type: 'AWS::S3::Bucket',
        properties: {},
        stackId: 'stack1'
      };
      const queue: GraphNode = {
        id: 'stack1::Queue',
        type: 'AWS::SQS::Queue',
        properties: {},
        stackId: 'stack1'
      };

      graph.addNode(bucket);
      graph.addNode(queue);
      graph.addEdge({ from: 'stack1::Queue', to: 'stack1::Bucket', type: EdgeType.DEPENDS_ON });

      const reversed = graph.opposite();

      expect(reversed.getDependencies('stack1::Bucket')).toEqual(['stack1::Queue']);
      expect(reversed.getDependents('stack1::Queue')).toEqual(['stack1::Bucket']);
    });

    test('should preserve crossStack flag on edges', () => {
      const node1: GraphNode = {
        id: 'stack1::Bucket',
        type: 'AWS::S3::Bucket',
        properties: {},
        stackId: 'stack1'
      };
      const node2: GraphNode = {
        id: 'stack2::Queue',
        type: 'AWS::SQS::Queue',
        properties: {},
        stackId: 'stack2'
      };

      graph.addNode(node1);
      graph.addNode(node2);
      graph.addEdge({ from: 'stack2::Queue', to: 'stack1::Bucket', type: EdgeType.IMPORT_VALUE, crossStack: true });

      const reversed = graph.opposite();
      const edges = reversed.getCrossStackEdges();

      expect(edges).toHaveLength(1);
      expect(edges[0].crossStack).toBe(true);
    });
  });
});

