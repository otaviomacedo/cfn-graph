import { CloudFormationParser } from '../src/parser';
import { CloudFormationGenerator } from '../src/generator';
import { CloudFormationGraph } from '../src/graph';
import { CloudFormationTemplate, GraphNode, EdgeType } from '../src/types';

describe('CloudFormationGenerator', () => {
  let generator: CloudFormationGenerator;
  let parser: CloudFormationParser;

  beforeEach(() => {
    generator = new CloudFormationGenerator();
    parser = new CloudFormationParser();
  });

  describe('Single Stack Generation', () => {
    test('should generate a simple template', () => {
      const graph = new CloudFormationGraph();
      const node: GraphNode = {
        id: 'stack1.Bucket',
        type: 'AWS::S3::Bucket',
        properties: { BucketName: 'test-bucket' },
        stackId: 'stack1'
      };

      graph.addNode(node);
      const template = generator.generate(graph, 'stack1');

      expect(template.Resources.Bucket).toBeDefined();
      expect(template.Resources.Bucket.Type).toBe('AWS::S3::Bucket');
      expect(template.Resources.Bucket.Properties).toBeDefined();
      expect(template.Resources.Bucket.Properties!.BucketName).toBe('test-bucket');
    });

    test('should include DependsOn in generated template', () => {
      const graph = new CloudFormationGraph();
      const bucket: GraphNode = {
        id: 'stack1.Bucket',
        type: 'AWS::S3::Bucket',
        properties: {},
        stackId: 'stack1'
      };
      const queue: GraphNode = {
        id: 'stack1.Queue',
        type: 'AWS::SQS::Queue',
        properties: {},
        stackId: 'stack1'
      };

      graph.addNode(bucket);
      graph.addNode(queue);
      graph.addEdge({
        from: 'stack1.Queue',
        to: 'stack1.Bucket',
        type: EdgeType.DEPENDS_ON
      });

      const template = generator.generate(graph, 'stack1');

      expect(template.Resources.Queue.DependsOn).toBe('Bucket');
    });

    test('should include multiple DependsOn as array', () => {
      const graph = new CloudFormationGraph();
      const bucket1: GraphNode = {
        id: 'stack1.Bucket1',
        type: 'AWS::S3::Bucket',
        properties: {},
        stackId: 'stack1'
      };
      const bucket2: GraphNode = {
        id: 'stack1.Bucket2',
        type: 'AWS::S3::Bucket',
        properties: {},
        stackId: 'stack1'
      };
      const queue: GraphNode = {
        id: 'stack1.Queue',
        type: 'AWS::SQS::Queue',
        properties: {},
        stackId: 'stack1'
      };

      graph.addNode(bucket1);
      graph.addNode(bucket2);
      graph.addNode(queue);
      graph.addEdge({
        from: 'stack1.Queue',
        to: 'stack1.Bucket1',
        type: EdgeType.DEPENDS_ON
      });
      graph.addEdge({
        from: 'stack1.Queue',
        to: 'stack1.Bucket2',
        type: EdgeType.DEPENDS_ON
      });

      const template = generator.generate(graph, 'stack1');

      expect(Array.isArray(template.Resources.Queue.DependsOn)).toBe(true);
      expect(template.Resources.Queue.DependsOn).toContain('Bucket1');
      expect(template.Resources.Queue.DependsOn).toContain('Bucket2');
    });

    test('should generate exports in outputs', () => {
      const graph = new CloudFormationGraph();
      const vpc: GraphNode = {
        id: 'stack1::VPC',
        type: 'AWS::EC2::VPC',
        properties: {},
        stackId: 'stack1'
      };
      const exportNode: GraphNode = {
        id: 'stack1.Export.VPC',
        type: 'AWS::CloudFormation::Export',
        properties: {
          Name: 'MyVPCId',
          Value: { Ref: 'VPC' }
        },
        stackId: 'stack1'
      };

      graph.addNode(vpc);
      graph.addNode(exportNode);
      graph.registerExport('MyVPCId', 'stack1.Export.VPC');

      const template = generator.generate(graph, 'stack1');

      expect(template.Outputs).toBeDefined();
      expect(template.Outputs!.VPC).toBeDefined();
      expect(template.Outputs!.VPC.Export?.Name).toBe('MyVPCId');
    });

    test('should include metadata in generated resources', () => {
      const graph = new CloudFormationGraph();
      const node: GraphNode = {
        id: 'stack1.Bucket',
        type: 'AWS::S3::Bucket',
        properties: {},
        metadata: { CustomKey: 'CustomValue' },
        stackId: 'stack1'
      };

      graph.addNode(node);
      const template = generator.generate(graph, 'stack1');

      expect(template.Resources.Bucket.Metadata).toEqual({ CustomKey: 'CustomValue' });
    });

    test('should generate resource policies', () => {
      const graph = new CloudFormationGraph();
      const node: GraphNode = {
        id: 'stack1.ASG',
        type: 'AWS::AutoScaling::AutoScalingGroup',
        properties: {},
        metadata: {
          CreationPolicy: { ResourceSignal: { Timeout: 'PT15M' } },
          UpdatePolicy: { AutoScalingRollingUpdate: { MinInstancesInService: 1 } },
          DeletionPolicy: 'Retain',
          UpdateReplacePolicy: 'Snapshot'
        },
        stackId: 'stack1'
      };

      graph.addNode(node);
      const template = generator.generate(graph, 'stack1');

      expect(template.Resources.ASG.CreationPolicy).toEqual({ ResourceSignal: { Timeout: 'PT15M' } });
      expect(template.Resources.ASG.UpdatePolicy).toEqual({ AutoScalingRollingUpdate: { MinInstancesInService: 1 } });
      expect(template.Resources.ASG.DeletionPolicy).toBe('Retain');
      expect(template.Resources.ASG.UpdateReplacePolicy).toBe('Snapshot');
      expect(template.Resources.ASG.Metadata).toBeUndefined();
    });

    test('should separate resource policies from metadata', () => {
      const graph = new CloudFormationGraph();
      const node: GraphNode = {
        id: 'stack1.Bucket',
        type: 'AWS::S3::Bucket',
        properties: {},
        metadata: {
          CustomKey: 'CustomValue',
          DeletionPolicy: 'Retain'
        },
        stackId: 'stack1'
      };

      graph.addNode(node);
      const template = generator.generate(graph, 'stack1');

      expect(template.Resources.Bucket.DeletionPolicy).toBe('Retain');
      expect(template.Resources.Bucket.Metadata).toEqual({ CustomKey: 'CustomValue' });
    });

    test('should not include cross-stack DependsOn', () => {
      const graph = new CloudFormationGraph();
      const bucket: GraphNode = {
        id: 'stack1.Bucket',
        type: 'AWS::S3::Bucket',
        properties: {},
        stackId: 'stack1'
      };
      const queue: GraphNode = {
        id: 'stack2.Queue',
        type: 'AWS::SQS::Queue',
        properties: {},
        stackId: 'stack2'
      };

      graph.addNode(bucket);
      graph.addNode(queue);
      graph.addEdge({
        from: 'stack2.Queue',
        to: 'stack1.Bucket',
        type: EdgeType.DEPENDS_ON,
        crossStack: true
      });

      const template = generator.generate(graph, 'stack2');

      expect(template.Resources.Queue.DependsOn).toBeUndefined();
    });
  });

  describe('Multi-Stack Generation', () => {
    test('should generate multiple templates', () => {
      const graph = new CloudFormationGraph();
      const bucket: GraphNode = {
        id: 'stack1.Bucket',
        type: 'AWS::S3::Bucket',
        properties: {},
        stackId: 'stack1'
      };
      const queue: GraphNode = {
        id: 'stack2.Queue',
        type: 'AWS::SQS::Queue',
        properties: {},
        stackId: 'stack2'
      };

      graph.addNode(bucket);
      graph.addNode(queue);

      const templates = generator.generateMultiple(graph);

      expect(templates.size).toBe(2);
      expect(templates.get('stack1')?.Resources.Bucket).toBeDefined();
      expect(templates.get('stack2')?.Resources.Queue).toBeDefined();
    });

    test('should generate separate templates for each stack', () => {
      const graph = new CloudFormationGraph();
      const bucket: GraphNode = {
        id: 'stack1.Bucket',
        type: 'AWS::S3::Bucket',
        properties: {},
        stackId: 'stack1'
      };
      const queue: GraphNode = {
        id: 'stack2.Queue',
        type: 'AWS::SQS::Queue',
        properties: {},
        stackId: 'stack2'
      };

      graph.addNode(bucket);
      graph.addNode(queue);

      const templates = generator.generateMultiple(graph);
      const stack1Template = templates.get('stack1')!;
      const stack2Template = templates.get('stack2')!;

      expect(Object.keys(stack1Template.Resources)).toEqual(['Bucket']);
      expect(Object.keys(stack2Template.Resources)).toEqual(['Queue']);
    });
  });

  describe('Cross-Stack Reference Transformation', () => {
    test('should convert Ref to Fn::ImportValue for cross-stack references', () => {
      const networkStack: CloudFormationTemplate = {
        Resources: {
          VPC: {
            Type: 'AWS::EC2::VPC',
            Properties: {}
          }
        },
        Outputs: {
          VPCId: {
            Value: { Ref: 'VPC' },
            Export: {
              Name: 'NetworkStack-VPCId'
            }
          }
        }
      };

      const appStack: CloudFormationTemplate = {
        Resources: {
          SecurityGroup: {
            Type: 'AWS::EC2::SecurityGroup',
            Properties: {
              VpcId: { Ref: 'VPC' }  // This will be in-stack initially
            }
          }
        }
      };

      const graph = parser.parseMultiple([
        { stackId: 'network', template: networkStack },
        { stackId: 'app', template: appStack }
      ]);

      // Move SecurityGroup's reference to create cross-stack scenario
      // In reality, this would happen through moveNode, but we'll simulate the graph state
      const sgNode = graph.getNode('app.SecurityGroup');
      if (sgNode) {
        // Add import edge
        const exportNodeId = graph.getExportNode('NetworkStack-VPCId');
        if (exportNodeId) {
          graph.addEdge({
            from: 'app.SecurityGroup',
            to: exportNodeId,
            type: EdgeType.IMPORT_VALUE,
            crossStack: true
          });
        }
      }

      const templates = generator.generateMultiple(graph);
      const appTemplate = templates.get('app')!;

      // The generator should convert Ref to Fn::ImportValue
      expect(appTemplate.Resources.SecurityGroup.Properties).toBeDefined();
      expect(appTemplate.Resources.SecurityGroup.Properties!.VpcId).toHaveProperty('Fn::ImportValue');
    });

    test('should handle moved nodes with converted references', () => {
      const infraStack: CloudFormationTemplate = {
        Resources: {
          Topic: {
            Type: 'AWS::SNS::Topic',
            Properties: {}
          },
          Subscription: {
            Type: 'AWS::SNS::Subscription',
            Properties: {
              TopicArn: { Ref: 'Topic' }
            }
          }
        }
      };

      const servicesStack: CloudFormationTemplate = {
        Resources: {
          Role: {
            Type: 'AWS::IAM::Role',
            Properties: {}
          }
        }
      };

      const graph = parser.parseMultiple([
        { stackId: 'infra', template: infraStack },
        { stackId: 'services', template: servicesStack }
      ]);

      // Move Subscription to services stack
      graph.moveNode('infra.Subscription', 'services', 'Subscription');

      const templates = generator.generateMultiple(graph);
      const infraTemplate = templates.get('infra')!;
      const servicesTemplate = templates.get('services')!;

      // Infra stack should have export
      expect(infraTemplate.Outputs).toBeDefined();
      expect(infraTemplate.Outputs!.Topic).toBeDefined();
      expect(infraTemplate.Outputs!.Topic.Export).toBeDefined();

      // Services stack should have ImportValue
      expect(servicesTemplate.Resources.Subscription).toBeDefined();
      expect(servicesTemplate.Resources.Subscription.Properties).toBeDefined();
      expect(servicesTemplate.Resources.Subscription.Properties!.TopicArn).toHaveProperty('Fn::ImportValue');
    });
  });

  describe('Round-Trip Consistency', () => {
    test('should maintain template structure through parse and generate', () => {
      const originalTemplate: CloudFormationTemplate = {
        AWSTemplateFormatVersion: '2010-09-09',
        Description: 'Test Stack',
        Resources: {
          Bucket: {
            Type: 'AWS::S3::Bucket',
            Properties: {
              BucketName: 'test-bucket'
            }
          },
          Queue: {
            Type: 'AWS::SQS::Queue',
            Properties: {},
            DependsOn: 'Bucket'
          }
        }
      };

      const graph = parser.parse(originalTemplate, 'stack1');
      const generatedTemplate = generator.generate(graph, 'stack1');

      expect(generatedTemplate.Resources.Bucket).toBeDefined();
      expect(generatedTemplate.Resources.Queue).toBeDefined();
      expect(generatedTemplate.Resources.Queue.DependsOn).toBe('Bucket');
      expect(generatedTemplate.Resources.Bucket.Properties).toBeDefined();
      expect(generatedTemplate.Resources.Bucket.Properties!.BucketName).toBe('test-bucket');
    });

    test('should preserve resource policies through round-trip', () => {
      const originalTemplate: CloudFormationTemplate = {
        Resources: {
          ASG: {
            Type: 'AWS::AutoScaling::AutoScalingGroup',
            Properties: {},
            DeletionPolicy: 'Retain',
            UpdateReplacePolicy: 'Snapshot'
          }
        }
      };

      const graph = parser.parse(originalTemplate, 'stack1');
      const generatedTemplate = generator.generate(graph, 'stack1');

      expect(generatedTemplate.Resources.ASG.DeletionPolicy).toBe('Retain');
      expect(generatedTemplate.Resources.ASG.UpdateReplacePolicy).toBe('Snapshot');
    });

    test('should preserve exports through round-trip', () => {
      const originalTemplate: CloudFormationTemplate = {
        Resources: {
          VPC: {
            Type: 'AWS::EC2::VPC',
            Properties: {}
          }
        },
        Outputs: {
          VPCId: {
            Value: { Ref: 'VPC' },
            Export: {
              Name: 'MyVPCId'
            }
          }
        }
      };

      const graph = parser.parse(originalTemplate, 'stack1');
      const generatedTemplate = generator.generate(graph, 'stack1');

      expect(generatedTemplate.Outputs).toBeDefined();
      expect(generatedTemplate.Outputs!.VPCId).toBeDefined();
      expect(generatedTemplate.Outputs!.VPCId.Export?.Name).toBe('MyVPCId');
    });
  });

  describe('Edge Cases', () => {
    test('should handle empty graph', () => {
      const graph = new CloudFormationGraph();
      const template = generator.generate(graph, 'stack1');

      expect(template.Resources).toEqual({});
    });

    test('should handle resources without properties', () => {
      const graph = new CloudFormationGraph();
      const node: GraphNode = {
        id: 'stack1.Bucket',
        type: 'AWS::S3::Bucket',
        properties: {},
        stackId: 'stack1'
      };

      graph.addNode(node);
      const template = generator.generate(graph, 'stack1');

      expect(template.Resources.Bucket).toBeDefined();
      expect(template.Resources.Bucket.Properties).toEqual({});
    });

    test('should handle complex nested properties', () => {
      const graph = new CloudFormationGraph();
      const node: GraphNode = {
        id: 'stack1.Policy',
        type: 'AWS::IAM::Policy',
        properties: {
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: ['s3:GetObject'],
                Resource: '*'
              }
            ]
          }
        },
        stackId: 'stack1'
      };

      graph.addNode(node);
      const template = generator.generate(graph, 'stack1');

      expect(template.Resources.Policy).toBeDefined();
      expect(template.Resources.Policy.Properties).toBeDefined();
      expect(template.Resources.Policy.Properties!.PolicyDocument).toBeDefined();
      expect(template.Resources.Policy.Properties!.PolicyDocument.Statement).toHaveLength(1);
    });
  });
});
