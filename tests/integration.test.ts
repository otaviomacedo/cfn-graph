import { CloudFormationParser, CloudFormationGenerator, parseNodeId, createNodeId } from '../src';
import { CloudFormationTemplate, EdgeType } from '../src/types';

describe('Integration Tests', () => {
  let parser: CloudFormationParser;
  let generator: CloudFormationGenerator;

  beforeEach(() => {
    parser = new CloudFormationParser();
    generator = new CloudFormationGenerator();
  });

  describe('Complete Workflow', () => {
    test('should handle full parse-manipulate-generate workflow', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          Bucket: {
            Type: 'AWS::S3::Bucket',
            Properties: {
              BucketName: 'original-bucket'
            }
          },
          Queue: {
            Type: 'AWS::SQS::Queue',
            Properties: {}
          }
        }
      };

      // Parse
      const graph = parser.parse(template, 'stack1');
      expect(graph.getAllNodes()).toHaveLength(2);

      // Manipulate - add a new node
      graph.addNode({
        id: 'stack1.Topic',
        type: 'AWS::SNS::Topic',
        properties: { TopicName: 'new-topic' },
        stackId: 'stack1'
      });

      // Manipulate - add edge
      graph.addEdge({
        from: 'stack1.Queue',
        to: 'stack1.Topic',
        type: EdgeType.DEPENDS_ON
      });

      // Generate
      const newTemplate = generator.generate(graph, 'stack1');

      expect(Object.keys(newTemplate.Resources)).toHaveLength(3);
      expect(newTemplate.Resources.Topic).toBeDefined();
      expect(newTemplate.Resources.Queue.DependsOn).toBe('Topic');
    });

    test('should handle multi-stack workflow with cross-stack references', () => {
      const networkStack: CloudFormationTemplate = {
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

      const appStack: CloudFormationTemplate = {
        Resources: {
          SecurityGroup: {
            Type: 'AWS::EC2::SecurityGroup',
            Properties: {
              VpcId: { 'Fn::ImportValue': 'NetworkStack-VPCId' }
            }
          }
        }
      };

      // Parse multiple stacks
      const graph = parser.parseMultiple([
        { stackId: 'network', template: networkStack },
        { stackId: 'app', template: appStack }
      ]);

      // Verify cross-stack edges
      const crossStackEdges = graph.getCrossStackEdges();
      expect(crossStackEdges.length).toBeGreaterThan(0);

      // Generate back
      const templates = generator.generateMultiple(graph);
      expect(templates.size).toBe(2);

      const networkTemplate = templates.get('network')!;
      const appTemplate = templates.get('app')!;

      expect(networkTemplate.Outputs?.VPCId.Export?.Name).toBe('NetworkStack-VPCId');
      expect(appTemplate.Resources.SecurityGroup.Properties).toBeDefined();
      expect(appTemplate.Resources.SecurityGroup.Properties!.VpcId).toHaveProperty('Fn::ImportValue');
    });
  });

  test('should preserve Fn::GetAtt cross-stack references in the round trip', () => {
    const networkStack: CloudFormationTemplate = {
      Resources: {
        VPC: {
          Type: 'AWS::EC2::VPC',
          Properties: { CidrBlock: '10.0.0.0/16' }
        }
      },
      Outputs: {
        VPCId: {
          Value: { "Fn::GetAtt": ['VPC', 'Id'] },
          Export: { Name: 'NetworkStack-VPCId' }
        }
      }
    };

    const appStack: CloudFormationTemplate = {
      Resources: {
        SecurityGroup: {
          Type: 'AWS::EC2::SecurityGroup',
          Properties: {
            VpcId: { 'Fn::ImportValue': 'NetworkStack-VPCId' }
          }
        }
      }
    };

    // Parse multiple stacks
    const graph = parser.parseMultiple([
      { stackId: 'network', template: networkStack },
      { stackId: 'app', template: appStack }
    ]);

    // Verify cross-stack edges
    const crossStackEdges = graph.getCrossStackEdges();
    expect(crossStackEdges.length).toBeGreaterThan(0);

    // Generate back
    const templates = generator.generateMultiple(graph);
    const networkTemplate = templates.get('network')!;
    expect(networkTemplate.Outputs?.VPCId.Value).toHaveProperty('Fn::GetAtt');

  });

  test('should preserve Fn::GetAtt in-stack references in the round trip', () => {
    const networkStack: CloudFormationTemplate = {
      Resources: {
        VPC: {
          Type: 'AWS::EC2::VPC',
          Properties: { CidrBlock: '10.0.0.0/16' }
        },
        SecurityGroup: {
          Type: 'AWS::EC2::SecurityGroup',
          Properties: {
            VpcId: { 'Fn::GetAtt': ['VPC', 'Id'] }
          }
        }
      },
    };

    // Parse multiple stacks
    const graph = parser.parse(networkStack, 'network');


    // Generate back
    const template = generator.generate(graph);
    expect(template.Resources?.SecurityGroup?.Properties?.VpcId).toHaveProperty('Fn::GetAtt');
  });

  describe('Node Movement Scenarios', () => {
    test('should handle moving resource within same stack', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          OldBucketName: {
            Type: 'AWS::S3::Bucket',
            Properties: {}
          }
        }
      };

      const graph = parser.parse(template, 'stack1');
      graph.moveNode({ stackId: 'stack1', logicalId: 'OldBucketName' }, { stackId: 'stack1', logicalId: 'NewBucketName' });

      const newTemplate = generator.generate(graph, 'stack1');

      expect(newTemplate.Resources.OldBucketName).toBeUndefined();
      expect(newTemplate.Resources.NewBucketName).toBeDefined();
      expect(newTemplate.Resources.NewBucketName.Type).toBe('AWS::S3::Bucket');
    });

    test('should update references when moving resource within same stack', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          OldBucketName: {
            Type: 'AWS::S3::Bucket',
            Properties: {}
          },
          Function: {
            Type: 'AWS::Lambda::Function',
            Properties: {
              Environment: {
                Variables: {
                  BUCKET: { Ref: 'OldBucketName' }
                }
              }
            }
          }
        }
      };

      const graph = parser.parse(template, 'stack1');
      graph.moveNode({ stackId: 'stack1', logicalId: 'OldBucketName' }, { stackId: 'stack1', logicalId: 'NewBucketName' });

      const newTemplate = generator.generate(graph, 'stack1');

      expect(newTemplate.Resources.NewBucketName).toBeDefined();
      expect(newTemplate.Resources.Function.Properties!.Environment.Variables.BUCKET).toEqual({ Ref: 'NewBucketName' });
    });

    test('should handle moving resource across stacks', () => {
      const stack1: CloudFormationTemplate = {
        Resources: {
          Bucket: {
            Type: 'AWS::S3::Bucket',
            Properties: {}
          }
        }
      };

      const stack2: CloudFormationTemplate = {
        Resources: {
          Queue: {
            Type: 'AWS::SQS::Queue',
            Properties: {}
          }
        }
      };

      const graph = parser.parseMultiple([
        { stackId: 'stack1', template: stack1 },
        { stackId: 'stack2', template: stack2 }
      ]);

      graph.moveNode({ stackId: 'stack1', logicalId: 'Bucket' }, { stackId: 'stack2', logicalId: 'Bucket' });

      const templates = generator.generateMultiple(graph);
      
      // Stack1 should not be in templates since it has no nodes after the move
      expect(templates.has('stack1')).toBe(false);
      
      const stack2Template = templates.get('stack2')!;
      expect(stack2Template.Resources.Bucket).toBeDefined();
      expect(Object.keys(stack2Template.Resources)).toHaveLength(2);
    });

    test('should convert in-stack reference to cross-stack import when moving', () => {
      const infraStack: CloudFormationTemplate = {
        Resources: {
          Topic: {
            Type: 'AWS::SNS::Topic',
            Properties: {}
          },
          Subscription: {
            Type: 'AWS::SNS::Subscription',
            Properties: {
              TopicArn: { Ref: 'Topic' },
              Protocol: 'email',
              Endpoint: 'test@example.com'
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

      // Before move - verify in-stack reference
      const edgesBefore = graph.getEdges('infra.Subscription');
      const refEdgeBefore = edgesBefore.find(e => e.type === EdgeType.REFERENCE);
      expect(refEdgeBefore?.crossStack).toBeFalsy();

      // Move subscription to services stack
      graph.moveNode({ stackId: 'infra', logicalId: 'Subscription' }, { stackId: 'services', logicalId: 'Subscription' });

      // After move - verify cross-stack import
      const edgesAfter = graph.getEdges('services.Subscription');
      const importEdge = edgesAfter.find(e => e.type === EdgeType.IMPORT_VALUE);
      expect(importEdge).toBeDefined();
      expect(importEdge?.crossStack).toBe(true);
      expect(importEdge?.to).toBe('infra.Topic');

      // Verify export was registered
      const exports = graph.getExports();
      const exportNames = Array.from(exports.keys());
      expect(exportNames.some(name => name.includes('Topic'))).toBe(true);

      // Generate templates
      const templates = generator.generateMultiple(graph);
      const infraTemplate = templates.get('infra')!;
      const servicesTemplate = templates.get('services')!;

      // Verify export in infra stack
      expect(infraTemplate.Outputs).toBeDefined();
      expect(infraTemplate.Outputs!.Topic).toBeDefined();

      // Verify ImportValue in services stack
      expect(servicesTemplate.Resources.Subscription).toBeDefined();
      expect(servicesTemplate.Resources.Subscription.Properties).toBeDefined();
      expect(servicesTemplate.Resources.Subscription.Properties!.TopicArn).toHaveProperty('Fn::ImportValue');
    });

    test('should handle moving resource with multiple dependencies', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          Bucket1: {
            Type: 'AWS::S3::Bucket',
            Properties: {}
          },
          Bucket2: {
            Type: 'AWS::S3::Bucket',
            Properties: {}
          },
          Function: {
            Type: 'AWS::Lambda::Function',
            Properties: {
              Environment: {
                Variables: {
                  BUCKET1: { Ref: 'Bucket1' },
                  BUCKET2: { Ref: 'Bucket2' }
                }
              }
            }
          }
        }
      };

      const stack2: CloudFormationTemplate = {
        Resources: {
          Queue: {
            Type: 'AWS::SQS::Queue',
            Properties: {}
          }
        }
      };

      const graph = parser.parseMultiple([
        { stackId: 'stack1', template: template },
        { stackId: 'stack2', template: stack2 }
      ]);

      // Move function to stack2
      graph.moveNode({ stackId: 'stack1', logicalId: 'Function' }, { stackId: 'stack2', logicalId: 'Function' });

      // Verify exports were created for both buckets
      const exports = graph.getExports();
      const exportNames = Array.from(exports.keys());
      expect(exportNames.some(name => name.includes('Bucket1'))).toBe(true);
      expect(exportNames.some(name => name.includes('Bucket2'))).toBe(true);

      // Generate and verify
      const templates = generator.generateMultiple(graph);
      const stack1Template = templates.get('stack1')!;
      const stack2Template = templates.get('stack2')!;

      expect(stack1Template.Outputs).toBeDefined();
      expect(Object.keys(stack1Template.Outputs!).length).toBeGreaterThanOrEqual(2);
      expect(stack2Template.Resources.Function).toBeDefined();
    });
  });

  describe('Complex Scenarios', () => {
    test('should handle circular dependencies detection', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          Resource1: {
            Type: 'AWS::S3::Bucket',
            Properties: {}
          },
          Resource2: {
            Type: 'AWS::SQS::Queue',
            Properties: {}
          }
        }
      };

      const graph = parser.parse(template, 'stack1');
      
      graph.addEdge({
        from: 'stack1.Resource1',
        to: 'stack1.Resource2',
        type: EdgeType.DEPENDS_ON
      });

      graph.addEdge({
        from: 'stack1.Resource2',
        to: 'stack1.Resource1',
        type: EdgeType.DEPENDS_ON
      });

      // Graph allows circular dependencies (CloudFormation will catch this at deploy time)
      const deps1 = graph.getDependencies('stack1.Resource1');
      const deps2 = graph.getDependencies('stack1.Resource2');

      expect(deps1).toContain('stack1.Resource2');
      expect(deps2).toContain('stack1.Resource1');
    });

    test('should handle deeply nested resource references', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          Bucket: {
            Type: 'AWS::S3::Bucket',
            Properties: {}
          },
          Policy: {
            Type: 'AWS::S3::BucketPolicy',
            Properties: {
              Bucket: { Ref: 'Bucket' },
              PolicyDocument: {
                Statement: [
                  {
                    Resource: {
                      'Fn::Sub': [
                        'arn:aws:s3:::${BucketName}/*',
                        { BucketName: { Ref: 'Bucket' } }
                      ]
                    }
                  }
                ]
              }
            }
          }
        }
      };

      const graph = parser.parse(template, 'stack1');
      const edges = graph.getEdges('stack1.Policy');
      const refEdges = edges.filter(e => e.type === EdgeType.REFERENCE && e.to === 'stack1.Bucket');

      expect(refEdges.length).toBeGreaterThan(0);
    });

    test('should handle resource removal and regeneration', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          Bucket: {
            Type: 'AWS::S3::Bucket',
            Properties: {}
          },
          Queue: {
            Type: 'AWS::SQS::Queue',
            Properties: {},
            DependsOn: 'Bucket'
          },
          Topic: {
            Type: 'AWS::SNS::Topic',
            Properties: {}
          }
        }
      };

      const graph = parser.parse(template, 'stack1');
      
      // Remove bucket (and its edges)
      graph.removeNode('stack1.Bucket');

      const newTemplate = generator.generate(graph, 'stack1');

      expect(newTemplate.Resources.Bucket).toBeUndefined();
      expect(newTemplate.Resources.Queue).toBeDefined();
      expect(newTemplate.Resources.Queue.DependsOn).toBeUndefined();
      expect(newTemplate.Resources.Topic).toBeDefined();
    });
  });

  describe('Utility Functions', () => {
    test('should parse and create node IDs correctly', () => {
      const nodeId = createNodeId('mystack', 'MyResource');
      expect(nodeId).toBe('mystack.MyResource');

      const parsed = parseNodeId(nodeId);
      expect(parsed.stackId).toBe('mystack');
      expect(parsed.logicalId).toBe('MyResource');
    });

    test('should handle complex logical IDs', () => {
      const nodeId = createNodeId('stack1', 'Export.VPC');
      const parsed = parseNodeId(nodeId);

      expect(parsed.stackId).toBe('stack1');
      expect(parsed.logicalId).toBe('Export.VPC');
    });

    test('should throw error for invalid node IDs', () => {
      expect(() => {
        parseNodeId('InvalidId');
      }).toThrow('Invalid qualified ID');
    });
  });
});
