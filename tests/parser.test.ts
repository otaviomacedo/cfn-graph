import { CloudFormationParser } from '../src/parser';
import { CloudFormationTemplate, EdgeType } from '../src/types';

describe('CloudFormationParser', () => {
  let parser: CloudFormationParser;

  beforeEach(() => {
    parser = new CloudFormationParser();
  });

  describe('Single Template Parsing', () => {
    test('should parse a simple template', () => {
      const template: CloudFormationTemplate = {
        AWSTemplateFormatVersion: '2010-09-09',
        Resources: {
          MyBucket: {
            Type: 'AWS::S3::Bucket',
            Properties: {
              BucketName: 'test-bucket'
            }
          }
        }
      };

      const graph = parser.parse(template, 'test-stack');
      const nodes = graph.getAllNodes();

      expect(nodes).toHaveLength(1);
      expect(nodes[0].id).toBe('test-stack.MyBucket');
      expect(nodes[0].type).toBe('AWS::S3::Bucket');
      expect(nodes[0].properties.BucketName).toBe('test-bucket');
    });

    test('should parse DependsOn relationships', () => {
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
          }
        }
      };

      const graph = parser.parse(template, 'stack1');
      const edges = graph.getEdges('stack1.Queue');
      const dependsOnEdge = edges.find(e => e.type === EdgeType.DEPENDS_ON);

      expect(dependsOnEdge).toBeDefined();
      expect(dependsOnEdge?.from).toBe('stack1.Queue');
      expect(dependsOnEdge?.to).toBe('stack1.Bucket');
    });

    test('should parse multiple DependsOn as array', () => {
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
          Queue: {
            Type: 'AWS::SQS::Queue',
            Properties: {},
            DependsOn: ['Bucket1', 'Bucket2']
          }
        }
      };

      const graph = parser.parse(template, 'stack1');
      const deps = graph.getDependencies('stack1.Queue');

      expect(deps).toHaveLength(2);
      expect(deps).toContain('stack1.Bucket1');
      expect(deps).toContain('stack1.Bucket2');
    });

    test('should parse Ref intrinsic functions', () => {
      const template: CloudFormationTemplate = {
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

      const graph = parser.parse(template, 'stack1');
      const edges = graph.getEdges('stack1.Subscription');
      const refEdge = edges.find(e => e.type === EdgeType.REFERENCE);

      expect(refEdge).toBeDefined();
      expect(refEdge?.to).toBe('stack1.Topic');
    });

    test('should parse Fn::GetAtt intrinsic functions', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          Queue: {
            Type: 'AWS::SQS::Queue',
            Properties: {}
          },
          Topic: {
            Type: 'AWS::SNS::Topic',
            Properties: {
              Subscription: [
                {
                  Endpoint: { 'Fn::GetAtt': ['Queue', 'Arn'] },
                  Protocol: 'sqs'
                }
              ]
            }
          }
        }
      };

      const graph = parser.parse(template, 'stack1');
      const edges = graph.getEdges('stack1.Topic');
      const getAttEdge = edges.find(e => e.type === EdgeType.GET_ATT);

      expect(getAttEdge).toBeDefined();
      expect(getAttEdge?.to).toBe('stack1.Queue');
    });

    test('should parse exports in outputs', () => {
      const template: CloudFormationTemplate = {
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

      const graph = parser.parse(template, 'stack1');
      
      // Check export was registered to VPC resource directly
      expect(graph.getExportNode('MyVPCId')).toBe('stack1.VPC');
    });
  });

  describe('Multi-Stack Parsing', () => {
    test('should parse multiple stacks', () => {
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

      expect(graph.getAllStacks()).toHaveLength(2);
      expect(graph.getNodesByStack('stack1')).toHaveLength(1);
      expect(graph.getNodesByStack('stack2')).toHaveLength(1);
    });

    test('should parse cross-stack references with ImportValue', () => {
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
              VpcId: { 'Fn::ImportValue': 'NetworkStack-VPCId' }
            }
          }
        }
      };

      const graph = parser.parseMultiple([
        { stackId: 'network', template: networkStack },
        { stackId: 'app', template: appStack }
      ]);

      // Check cross-stack edge exists
      const crossStackEdges = graph.getCrossStackEdges();
      expect(crossStackEdges.length).toBeGreaterThan(0);

      const importEdge = crossStackEdges.find(
        e => e.type === EdgeType.IMPORT_VALUE && e.from === 'app.SecurityGroup'
      );
      expect(importEdge).toBeDefined();
      expect(importEdge?.crossStack).toBe(true);
    });

    test('should handle multiple imports from same export', () => {
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
              Name: 'SharedVPC'
            }
          }
        }
      };

      const app1Stack: CloudFormationTemplate = {
        Resources: {
          SG1: {
            Type: 'AWS::EC2::SecurityGroup',
            Properties: {
              VpcId: { 'Fn::ImportValue': 'SharedVPC' }
            }
          }
        }
      };

      const app2Stack: CloudFormationTemplate = {
        Resources: {
          SG2: {
            Type: 'AWS::EC2::SecurityGroup',
            Properties: {
              VpcId: { 'Fn::ImportValue': 'SharedVPC' }
            }
          }
        }
      };

      const graph = parser.parseMultiple([
        { stackId: 'network', template: networkStack },
        { stackId: 'app1', template: app1Stack },
        { stackId: 'app2', template: app2Stack }
      ]);

      const crossStackEdges = graph.getCrossStackEdges();
      const importEdges = crossStackEdges.filter(e => e.type === EdgeType.IMPORT_VALUE);
      
      expect(importEdges.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Edge Cases', () => {
    test('should handle empty template', () => {
      const template: CloudFormationTemplate = {
        Resources: {}
      };

      const graph = parser.parse(template, 'stack1');
      expect(graph.getAllNodes()).toHaveLength(0);
    });

    test('should handle resources without properties', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          Bucket: {
            Type: 'AWS::S3::Bucket'
          }
        }
      };

      const graph = parser.parse(template, 'stack1');
      const node = graph.getNode('stack1.Bucket');
      
      expect(node).toBeDefined();
      expect(node?.properties).toEqual({});
    });

    test('should handle nested Ref in complex structures', () => {
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

    test('should handle metadata on resources', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          Bucket: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
            Metadata: {
              CustomKey: 'CustomValue'
            }
          }
        }
      };

      const graph = parser.parse(template, 'stack1');
      const node = graph.getNode('stack1.Bucket');
      
      expect(node?.metadata).toEqual({ CustomKey: 'CustomValue' });
    });

    test('should parse resource policies', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          ASG: {
            Type: 'AWS::AutoScaling::AutoScalingGroup',
            Properties: {},
            CreationPolicy: {
              ResourceSignal: { Timeout: 'PT15M' }
            },
            UpdatePolicy: {
              AutoScalingRollingUpdate: { MinInstancesInService: 1 }
            },
            DeletionPolicy: 'Retain',
            UpdateReplacePolicy: 'Snapshot'
          }
        }
      };

      const graph = parser.parse(template, 'stack1');
      const node = graph.getNode('stack1.ASG');
      
      expect(node?.metadata?.CreationPolicy).toEqual({ ResourceSignal: { Timeout: 'PT15M' } });
      expect(node?.metadata?.UpdatePolicy).toEqual({ AutoScalingRollingUpdate: { MinInstancesInService: 1 } });
      expect(node?.metadata?.DeletionPolicy).toBe('Retain');
      expect(node?.metadata?.UpdateReplacePolicy).toBe('Snapshot');
    });
  });
  describe('Primitive Export Values', () => {
    test('should not create edge when export value is a primitive string', () => {
      const configStack: CloudFormationTemplate = {
        Resources: {},
        Outputs: {
          Region: {
            Value: 'us-east-1',
            Export: {
              Name: 'ConfigRegion'
            }
          }
        }
      };

      const appStack: CloudFormationTemplate = {
        Resources: {
          Bucket: {
            Type: 'AWS::S3::Bucket',
            Properties: {
              BucketName: { 'Fn::ImportValue': 'ConfigRegion' }
            }
          }
        }
      };

      const graph = parser.parseMultiple([
        { stackId: 'config', template: configStack },
        { stackId: 'app', template: appStack }
      ]);

      // No export should be registered since there's no resource reference
      expect(graph.getExportNode('ConfigRegion')).toBeUndefined();

      // No import edge should exist
      const importEdges = graph.getEdges('app.Bucket').filter(e => e.type === EdgeType.IMPORT_VALUE);
      expect(importEdges).toHaveLength(0);
    });

    test('should not create edge when export value is a number', () => {
      const configStack: CloudFormationTemplate = {
        Resources: {},
        Outputs: {
          MaxSize: {
            Value: 100,
            Export: {
              Name: 'ConfigMaxSize'
            }
          }
        }
      };

      const appStack: CloudFormationTemplate = {
        Resources: {
          Queue: {
            Type: 'AWS::SQS::Queue',
            Properties: {
              MaximumMessageSize: { 'Fn::ImportValue': 'ConfigMaxSize' }
            }
          }
        }
      };

      const graph = parser.parseMultiple([
        { stackId: 'config', template: configStack },
        { stackId: 'app', template: appStack }
      ]);

      expect(graph.getExportNode('ConfigMaxSize')).toBeUndefined();

      const importEdges = graph.getEdges('app.Queue').filter(e => e.type === EdgeType.IMPORT_VALUE);
      expect(importEdges).toHaveLength(0);
    });

    test('should create edge when export value references a resource', () => {
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
              Name: 'NetworkVPC'
            }
          }
        }
      };

      const appStack: CloudFormationTemplate = {
        Resources: {
          SecurityGroup: {
            Type: 'AWS::EC2::SecurityGroup',
            Properties: {
              VpcId: { 'Fn::ImportValue': 'NetworkVPC' }
            }
          }
        }
      };

      const graph = parser.parseMultiple([
        { stackId: 'network', template: networkStack },
        { stackId: 'app', template: appStack }
      ]);

      // Export should be registered to the VPC resource
      expect(graph.getExportNode('NetworkVPC')).toBe('network.VPC');

      // Import edge should exist pointing to VPC
      const importEdges = graph.getEdges('app.SecurityGroup').filter(e => e.type === EdgeType.IMPORT_VALUE);
      expect(importEdges).toHaveLength(1);
      expect(importEdges[0].to).toBe('network.VPC');
    });
  });
});

