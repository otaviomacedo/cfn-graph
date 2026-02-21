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

    test('should convert Fn::GetAtt to cross-stack import when moving, preserving the Fn::GetAtt and attribute', () => {
      const infraStack: CloudFormationTemplate = {
        Resources: {
          Table: {
            Type: 'AWS::DynamoDB::Table',
            Properties: {}
          },
          Function: {
            Type: 'AWS::Lambda::Function',
            Properties: {
              Environment: {
                Variables: {
                  TABLE_ARN: { 'Fn::GetAtt': ['Table', 'Arn'] }
                }
              }
            }
          }
        }
      };

      const servicesStack: CloudFormationTemplate = {
        Resources: {
          Queue: {
            Type: 'AWS::SQS::Queue',
            Properties: {}
          }
        }
      };

      const graph = parser.parseMultiple([
        { stackId: 'infra', template: infraStack },
        { stackId: 'services', template: servicesStack }
      ]);

      graph.moveNode({ stackId: 'infra', logicalId: 'Function' }, { stackId: 'services', logicalId: 'Function' });

      const templates = generator.generateMultiple(graph);
      const infraTemplate = templates.get('infra')!;
      const servicesTemplate = templates.get('services')!;

      expect(infraTemplate.Outputs).toBeDefined();
      expect(infraTemplate.Outputs!.Table).toBeDefined();
      expect(infraTemplate.Outputs!.Table.Value).toHaveProperty('Fn::GetAtt');
      expect(infraTemplate.Outputs!.Table.Value['Fn::GetAtt']).toEqual(['Table', 'Arn']);

      expect(servicesTemplate.Resources.Function.Properties!.Environment.Variables.TABLE_ARN).toHaveProperty('Fn::ImportValue');
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

    test('should preserve references when moving both resources to different stack', () => {
      const stack1: CloudFormationTemplate = {
        Resources: {
          Bucket: {
            Type: 'AWS::S3::Bucket',
            Properties: {}
          },
          Function: {
            Type: 'AWS::Lambda::Function',
            Properties: {
              Environment: {
                Variables: {
                  BUCKET: { Ref: 'Bucket' }
                }
              }
            },
            DependsOn: 'Bucket'
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

      // Move both resources to stack2
      graph.moveNode({ stackId: 'stack1', logicalId: 'Bucket' }, { stackId: 'stack2', logicalId: 'Bucket' });
      graph.moveNode({ stackId: 'stack1', logicalId: 'Function' }, { stackId: 'stack2', logicalId: 'Function' });

      const templates = generator.generateMultiple(graph);
      const stack2Template = templates.get('stack2')!;

      // Verify both resources are in stack2
      expect(stack2Template.Resources.Bucket).toBeDefined();
      expect(stack2Template.Resources.Function).toBeDefined();

      // Verify Ref remains unchanged (not converted to ImportValue)
      expect(stack2Template.Resources.Function.Properties!.Environment.Variables.BUCKET).toEqual({ Ref: 'Bucket' });

      // Verify DependsOn remains unchanged
      expect(stack2Template.Resources.Function.DependsOn).toBe('Bucket');

      // Verify no exports were created (since both moved together)
      expect(stack2Template.Outputs).toBeUndefined();
    });

    test('large template', () => {
      const apiStack = {
        "Resources": {
          "usersTable12EF4ADD": {
            "Type": "AWS::DynamoDB::Table",
            "Properties": {
              "AttributeDefinitions": [
                {
                  "AttributeName": "id",
                  "AttributeType": "S"
                }
              ],
              "KeySchema": [
                {
                  "AttributeName": "id",
                  "KeyType": "HASH"
                }
              ],
              "ProvisionedThroughput": {
                "ReadCapacityUnits": 5,
                "WriteCapacityUnits": 5
              },
              "TableName": "users"
            },
            "UpdateReplacePolicy": "Retain",
            "DeletionPolicy": "Retain",
            "Metadata": {
              "aws:cdk:path": "ApiStack/usersTable/Resource"
            }
          },
          "usersFunctionServiceRole343B7540": {
            "Type": "AWS::IAM::Role",
            "Properties": {
              "AssumeRolePolicyDocument": {
                "Statement": [
                  {
                    "Action": "sts:AssumeRole",
                    "Effect": "Allow",
                    "Principal": {
                      "Service": "lambda.amazonaws.com"
                    }
                  }
                ],
                "Version": "2012-10-17"
              },
              "ManagedPolicyArns": [
                {
                  "Fn::Join": [
                    "",
                    [
                      "arn:",
                      {
                        "Ref": "AWS::Partition"
                      },
                      ":iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
                    ]
                  ]
                }
              ]
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/usersFunction/ServiceRole/Resource"
            }
          },
          "usersFunctionServiceRoleDefaultPolicy2F642C08": {
            "Type": "AWS::IAM::Policy",
            "Properties": {
              "PolicyDocument": {
                "Statement": [
                  {
                    "Action": [
                      "dynamodb:BatchGetItem",
                      "dynamodb:BatchWriteItem",
                      "dynamodb:ConditionCheckItem",
                      "dynamodb:DeleteItem",
                      "dynamodb:DescribeTable",
                      "dynamodb:GetItem",
                      "dynamodb:GetRecords",
                      "dynamodb:GetShardIterator",
                      "dynamodb:PutItem",
                      "dynamodb:Query",
                      "dynamodb:Scan",
                      "dynamodb:UpdateItem"
                    ],
                    "Effect": "Allow",
                    "Resource": [
                      {
                        "Fn::GetAtt": [
                          "usersTable12EF4ADD",
                          "Arn"
                        ]
                      },
                      {
                        "Ref": "AWS::NoValue"
                      }
                    ]
                  }
                ],
                "Version": "2012-10-17"
              },
              "PolicyName": "usersFunctionServiceRoleDefaultPolicy2F642C08",
              "Roles": [
                {
                  "Ref": "usersFunctionServiceRole343B7540"
                }
              ]
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/usersFunction/ServiceRole/DefaultPolicy/Resource"
            }
          },
          "usersFunctionA84FE85A": {
            "Type": "AWS::Lambda::Function",
            "Properties": {
              "Code": {
                "ZipFile": "console.log(users)"
              },
              "Handler": "index.handler",
              "Role": {
                "Fn::GetAtt": [
                  "usersFunctionServiceRole343B7540",
                  "Arn"
                ]
              },
              "Runtime": "nodejs22.x"
            },
            "DependsOn": [
              "usersFunctionServiceRoleDefaultPolicy2F642C08",
              "usersFunctionServiceRole343B7540"
            ],
            "Metadata": {
              "aws:cdk:path": "ApiStack/usersFunction/Resource"
            }
          },
          "productsTable368A23F4": {
            "Type": "AWS::DynamoDB::Table",
            "Properties": {
              "AttributeDefinitions": [
                {
                  "AttributeName": "id",
                  "AttributeType": "S"
                }
              ],
              "KeySchema": [
                {
                  "AttributeName": "id",
                  "KeyType": "HASH"
                }
              ],
              "ProvisionedThroughput": {
                "ReadCapacityUnits": 5,
                "WriteCapacityUnits": 5
              },
              "TableName": "products"
            },
            "UpdateReplacePolicy": "Retain",
            "DeletionPolicy": "Retain",
            "Metadata": {
              "aws:cdk:path": "ApiStack/productsTable/Resource"
            }
          },
          "productsFunctionServiceRole82AD24EA": {
            "Type": "AWS::IAM::Role",
            "Properties": {
              "AssumeRolePolicyDocument": {
                "Statement": [
                  {
                    "Action": "sts:AssumeRole",
                    "Effect": "Allow",
                    "Principal": {
                      "Service": "lambda.amazonaws.com"
                    }
                  }
                ],
                "Version": "2012-10-17"
              },
              "ManagedPolicyArns": [
                {
                  "Fn::Join": [
                    "",
                    [
                      "arn:",
                      {
                        "Ref": "AWS::Partition"
                      },
                      ":iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
                    ]
                  ]
                }
              ]
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/productsFunction/ServiceRole/Resource"
            }
          },
          "productsFunctionServiceRoleDefaultPolicy3E0B1ECC": {
            "Type": "AWS::IAM::Policy",
            "Properties": {
              "PolicyDocument": {
                "Statement": [
                  {
                    "Action": [
                      "dynamodb:BatchGetItem",
                      "dynamodb:BatchWriteItem",
                      "dynamodb:ConditionCheckItem",
                      "dynamodb:DeleteItem",
                      "dynamodb:DescribeTable",
                      "dynamodb:GetItem",
                      "dynamodb:GetRecords",
                      "dynamodb:GetShardIterator",
                      "dynamodb:PutItem",
                      "dynamodb:Query",
                      "dynamodb:Scan",
                      "dynamodb:UpdateItem"
                    ],
                    "Effect": "Allow",
                    "Resource": [
                      {
                        "Fn::GetAtt": [
                          "productsTable368A23F4",
                          "Arn"
                        ]
                      },
                      {
                        "Ref": "AWS::NoValue"
                      }
                    ]
                  }
                ],
                "Version": "2012-10-17"
              },
              "PolicyName": "productsFunctionServiceRoleDefaultPolicy3E0B1ECC",
              "Roles": [
                {
                  "Ref": "productsFunctionServiceRole82AD24EA"
                }
              ]
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/productsFunction/ServiceRole/DefaultPolicy/Resource"
            }
          },
          "productsFunctionC4182BE6": {
            "Type": "AWS::Lambda::Function",
            "Properties": {
              "Code": {
                "ZipFile": "console.log(products)"
              },
              "Handler": "index.handler",
              "Role": {
                "Fn::GetAtt": [
                  "productsFunctionServiceRole82AD24EA",
                  "Arn"
                ]
              },
              "Runtime": "nodejs22.x"
            },
            "DependsOn": [
              "productsFunctionServiceRoleDefaultPolicy3E0B1ECC",
              "productsFunctionServiceRole82AD24EA"
            ],
            "Metadata": {
              "aws:cdk:path": "ApiStack/productsFunction/Resource"
            }
          },
          "ordersTable623D0096": {
            "Type": "AWS::DynamoDB::Table",
            "Properties": {
              "AttributeDefinitions": [
                {
                  "AttributeName": "id",
                  "AttributeType": "S"
                }
              ],
              "KeySchema": [
                {
                  "AttributeName": "id",
                  "KeyType": "HASH"
                }
              ],
              "ProvisionedThroughput": {
                "ReadCapacityUnits": 5,
                "WriteCapacityUnits": 5
              },
              "TableName": "orders"
            },
            "UpdateReplacePolicy": "Retain",
            "DeletionPolicy": "Retain",
            "Metadata": {
              "aws:cdk:path": "ApiStack/ordersTable/Resource"
            }
          },
          "ordersFunctionServiceRoleA33ACDBF": {
            "Type": "AWS::IAM::Role",
            "Properties": {
              "AssumeRolePolicyDocument": {
                "Statement": [
                  {
                    "Action": "sts:AssumeRole",
                    "Effect": "Allow",
                    "Principal": {
                      "Service": "lambda.amazonaws.com"
                    }
                  }
                ],
                "Version": "2012-10-17"
              },
              "ManagedPolicyArns": [
                {
                  "Fn::Join": [
                    "",
                    [
                      "arn:",
                      {
                        "Ref": "AWS::Partition"
                      },
                      ":iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
                    ]
                  ]
                }
              ]
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/ordersFunction/ServiceRole/Resource"
            }
          },
          "ordersFunctionServiceRoleDefaultPolicy51A7D1F9": {
            "Type": "AWS::IAM::Policy",
            "Properties": {
              "PolicyDocument": {
                "Statement": [
                  {
                    "Action": [
                      "dynamodb:BatchGetItem",
                      "dynamodb:BatchWriteItem",
                      "dynamodb:ConditionCheckItem",
                      "dynamodb:DeleteItem",
                      "dynamodb:DescribeTable",
                      "dynamodb:GetItem",
                      "dynamodb:GetRecords",
                      "dynamodb:GetShardIterator",
                      "dynamodb:PutItem",
                      "dynamodb:Query",
                      "dynamodb:Scan",
                      "dynamodb:UpdateItem"
                    ],
                    "Effect": "Allow",
                    "Resource": [
                      {
                        "Fn::GetAtt": [
                          "ordersTable623D0096",
                          "Arn"
                        ]
                      },
                      {
                        "Ref": "AWS::NoValue"
                      }
                    ]
                  }
                ],
                "Version": "2012-10-17"
              },
              "PolicyName": "ordersFunctionServiceRoleDefaultPolicy51A7D1F9",
              "Roles": [
                {
                  "Ref": "ordersFunctionServiceRoleA33ACDBF"
                }
              ]
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/ordersFunction/ServiceRole/DefaultPolicy/Resource"
            }
          },
          "ordersFunction3ED8FDBE": {
            "Type": "AWS::Lambda::Function",
            "Properties": {
              "Code": {
                "ZipFile": "console.log(orders)"
              },
              "Handler": "index.handler",
              "Role": {
                "Fn::GetAtt": [
                  "ordersFunctionServiceRoleA33ACDBF",
                  "Arn"
                ]
              },
              "Runtime": "nodejs22.x"
            },
            "DependsOn": [
              "ordersFunctionServiceRoleDefaultPolicy51A7D1F9",
              "ordersFunctionServiceRoleA33ACDBF"
            ],
            "Metadata": {
              "aws:cdk:path": "ApiStack/ordersFunction/Resource"
            }
          },
          "MicroservicesApiFE627B22": {
            "Type": "AWS::ApiGateway::RestApi",
            "Properties": {
              "EndpointConfiguration": {
                "Types": [
                  "REGIONAL"
                ]
              },
              "Name": "ApplicationAPI"
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Resource"
            }
          },
          "MicroservicesApiDeployment57F63DCA0a15cf4580753002e94d9826f012d544": {
            "Type": "AWS::ApiGateway::Deployment",
            "Properties": {
              "Description": "Automatically created by the RestApi construct",
              "RestApiId": {
                "Ref": "MicroservicesApiFE627B22"
              }
            },
            "DependsOn": [
              "MicroservicesApiOPTIONS58D6E1C4",
              "MicroservicesApiordersDELETE5B2AACFF",
              "MicroservicesApiordersGETEBC6F451",
              "MicroservicesApiordersOPTIONSB8B41997",
              "MicroservicesApiordersPOST3347A41E",
              "MicroservicesApiordersPUT9F9490B0",
              "MicroservicesApiorders32EBBB69",
              "MicroservicesApiproductsDELETE7CCC64C1",
              "MicroservicesApiproductsGETB90AB035",
              "MicroservicesApiproductsOPTIONS9CBB9DAF",
              "MicroservicesApiproductsPOSTB66C1ACB",
              "MicroservicesApiproductsPUTE97F97AA",
              "MicroservicesApiproductsEF6644D3",
              "MicroservicesApiusersDELETEF3258329",
              "MicroservicesApiusersGET27DB1AE6",
              "MicroservicesApiusersOPTIONS42EE2103",
              "MicroservicesApiusersPOSTC479D7F8",
              "MicroservicesApiusersPUT8D1BB6F7",
              "MicroservicesApiusers5A69665A"
            ],
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Deployment/Resource"
            }
          },
          "MicroservicesApiDeploymentStageprod4C2D8015": {
            "Type": "AWS::ApiGateway::Stage",
            "Properties": {
              "DeploymentId": {
                "Ref": "MicroservicesApiDeployment57F63DCA0a15cf4580753002e94d9826f012d544"
              },
              "RestApiId": {
                "Ref": "MicroservicesApiFE627B22"
              },
              "StageName": "prod"
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/DeploymentStage.prod/Resource"
            }
          },
          "MicroservicesApiOPTIONS58D6E1C4": {
            "Type": "AWS::ApiGateway::Method",
            "Properties": {
              "ApiKeyRequired": false,
              "AuthorizationType": "NONE",
              "HttpMethod": "OPTIONS",
              "Integration": {
                "IntegrationResponses": [
                  {
                    "ResponseParameters": {
                      "method.response.header.Access-Control-Allow-Headers": "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Amz-User-Agent'",
                      "method.response.header.Access-Control-Allow-Origin": "'*'",
                      "method.response.header.Access-Control-Allow-Methods": "'OPTIONS,GET,PUT,POST,DELETE,PATCH,HEAD'"
                    },
                    "StatusCode": "204"
                  }
                ],
                "RequestTemplates": {
                  "application/json": "{ statusCode: 200 }"
                },
                "Type": "MOCK"
              },
              "MethodResponses": [
                {
                  "ResponseParameters": {
                    "method.response.header.Access-Control-Allow-Headers": true,
                    "method.response.header.Access-Control-Allow-Origin": true,
                    "method.response.header.Access-Control-Allow-Methods": true
                  },
                  "StatusCode": "204"
                }
              ],
              "ResourceId": {
                "Fn::GetAtt": [
                  "MicroservicesApiFE627B22",
                  "RootResourceId"
                ]
              },
              "RestApiId": {
                "Ref": "MicroservicesApiFE627B22"
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/OPTIONS/Resource"
            }
          },
          "MicroservicesApiusers5A69665A": {
            "Type": "AWS::ApiGateway::Resource",
            "Properties": {
              "ParentId": {
                "Fn::GetAtt": [
                  "MicroservicesApiFE627B22",
                  "RootResourceId"
                ]
              },
              "PathPart": "users",
              "RestApiId": {
                "Ref": "MicroservicesApiFE627B22"
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/users/Resource"
            }
          },
          "MicroservicesApiusersOPTIONS42EE2103": {
            "Type": "AWS::ApiGateway::Method",
            "Properties": {
              "ApiKeyRequired": false,
              "AuthorizationType": "NONE",
              "HttpMethod": "OPTIONS",
              "Integration": {
                "IntegrationResponses": [
                  {
                    "ResponseParameters": {
                      "method.response.header.Access-Control-Allow-Headers": "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Amz-User-Agent'",
                      "method.response.header.Access-Control-Allow-Origin": "'*'",
                      "method.response.header.Access-Control-Allow-Methods": "'OPTIONS,GET,PUT,POST,DELETE,PATCH,HEAD'"
                    },
                    "StatusCode": "204"
                  }
                ],
                "RequestTemplates": {
                  "application/json": "{ statusCode: 200 }"
                },
                "Type": "MOCK"
              },
              "MethodResponses": [
                {
                  "ResponseParameters": {
                    "method.response.header.Access-Control-Allow-Headers": true,
                    "method.response.header.Access-Control-Allow-Origin": true,
                    "method.response.header.Access-Control-Allow-Methods": true
                  },
                  "StatusCode": "204"
                }
              ],
              "ResourceId": {
                "Ref": "MicroservicesApiusers5A69665A"
              },
              "RestApiId": {
                "Ref": "MicroservicesApiFE627B22"
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/users/OPTIONS/Resource"
            }
          },
          "MicroservicesApiusersGETApiPermissionApiStackMicroservicesApi502F81B5GETusers4FCBA78C": {
            "Type": "AWS::Lambda::Permission",
            "Properties": {
              "Action": "lambda:InvokeFunction",
              "FunctionName": {
                "Fn::GetAtt": [
                  "usersFunctionA84FE85A",
                  "Arn"
                ]
              },
              "Principal": "apigateway.amazonaws.com",
              "SourceArn": {
                "Fn::Join": [
                  "",
                  [
                    "arn:aws:execute-api:eu-central-1:669420849322:",
                    {
                      "Ref": "MicroservicesApiFE627B22"
                    },
                    "/",
                    {
                      "Ref": "MicroservicesApiDeploymentStageprod4C2D8015"
                    },
                    "/GET/users"
                  ]
                ]
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/users/GET/ApiPermission.ApiStackMicroservicesApi502F81B5.GET..users"
            }
          },
          "MicroservicesApiusersGETApiPermissionTestApiStackMicroservicesApi502F81B5GETusers46A089D7": {
            "Type": "AWS::Lambda::Permission",
            "Properties": {
              "Action": "lambda:InvokeFunction",
              "FunctionName": {
                "Fn::GetAtt": [
                  "usersFunctionA84FE85A",
                  "Arn"
                ]
              },
              "Principal": "apigateway.amazonaws.com",
              "SourceArn": {
                "Fn::Join": [
                  "",
                  [
                    "arn:aws:execute-api:eu-central-1:669420849322:",
                    {
                      "Ref": "MicroservicesApiFE627B22"
                    },
                    "/test-invoke-stage/GET/users"
                  ]
                ]
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/users/GET/ApiPermission.Test.ApiStackMicroservicesApi502F81B5.GET..users"
            }
          },
          "MicroservicesApiusersGET27DB1AE6": {
            "Type": "AWS::ApiGateway::Method",
            "Properties": {
              "AuthorizationType": "NONE",
              "HttpMethod": "GET",
              "Integration": {
                "IntegrationHttpMethod": "POST",
                "Type": "AWS_PROXY",
                "Uri": {
                  "Fn::Join": [
                    "",
                    [
                      "arn:aws:apigateway:eu-central-1:lambda:path/2015-03-31/functions/",
                      {
                        "Fn::GetAtt": [
                          "usersFunctionA84FE85A",
                          "Arn"
                        ]
                      },
                      "/invocations"
                    ]
                  ]
                }
              },
              "ResourceId": {
                "Ref": "MicroservicesApiusers5A69665A"
              },
              "RestApiId": {
                "Ref": "MicroservicesApiFE627B22"
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/users/GET/Resource"
            }
          },
          "MicroservicesApiusersPOSTApiPermissionApiStackMicroservicesApi502F81B5POSTusers7359C338": {
            "Type": "AWS::Lambda::Permission",
            "Properties": {
              "Action": "lambda:InvokeFunction",
              "FunctionName": {
                "Fn::GetAtt": [
                  "usersFunctionA84FE85A",
                  "Arn"
                ]
              },
              "Principal": "apigateway.amazonaws.com",
              "SourceArn": {
                "Fn::Join": [
                  "",
                  [
                    "arn:aws:execute-api:eu-central-1:669420849322:",
                    {
                      "Ref": "MicroservicesApiFE627B22"
                    },
                    "/",
                    {
                      "Ref": "MicroservicesApiDeploymentStageprod4C2D8015"
                    },
                    "/POST/users"
                  ]
                ]
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/users/POST/ApiPermission.ApiStackMicroservicesApi502F81B5.POST..users"
            }
          },
          "MicroservicesApiusersPOSTApiPermissionTestApiStackMicroservicesApi502F81B5POSTusersCD3566DB": {
            "Type": "AWS::Lambda::Permission",
            "Properties": {
              "Action": "lambda:InvokeFunction",
              "FunctionName": {
                "Fn::GetAtt": [
                  "usersFunctionA84FE85A",
                  "Arn"
                ]
              },
              "Principal": "apigateway.amazonaws.com",
              "SourceArn": {
                "Fn::Join": [
                  "",
                  [
                    "arn:aws:execute-api:eu-central-1:669420849322:",
                    {
                      "Ref": "MicroservicesApiFE627B22"
                    },
                    "/test-invoke-stage/POST/users"
                  ]
                ]
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/users/POST/ApiPermission.Test.ApiStackMicroservicesApi502F81B5.POST..users"
            }
          },
          "MicroservicesApiusersPOSTC479D7F8": {
            "Type": "AWS::ApiGateway::Method",
            "Properties": {
              "AuthorizationType": "NONE",
              "HttpMethod": "POST",
              "Integration": {
                "IntegrationHttpMethod": "POST",
                "Type": "AWS_PROXY",
                "Uri": {
                  "Fn::Join": [
                    "",
                    [
                      "arn:aws:apigateway:eu-central-1:lambda:path/2015-03-31/functions/",
                      {
                        "Fn::GetAtt": [
                          "usersFunctionA84FE85A",
                          "Arn"
                        ]
                      },
                      "/invocations"
                    ]
                  ]
                }
              },
              "ResourceId": {
                "Ref": "MicroservicesApiusers5A69665A"
              },
              "RestApiId": {
                "Ref": "MicroservicesApiFE627B22"
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/users/POST/Resource"
            }
          },
          "MicroservicesApiusersPUTApiPermissionApiStackMicroservicesApi502F81B5PUTusersD3C28D1F": {
            "Type": "AWS::Lambda::Permission",
            "Properties": {
              "Action": "lambda:InvokeFunction",
              "FunctionName": {
                "Fn::GetAtt": [
                  "usersFunctionA84FE85A",
                  "Arn"
                ]
              },
              "Principal": "apigateway.amazonaws.com",
              "SourceArn": {
                "Fn::Join": [
                  "",
                  [
                    "arn:aws:execute-api:eu-central-1:669420849322:",
                    {
                      "Ref": "MicroservicesApiFE627B22"
                    },
                    "/",
                    {
                      "Ref": "MicroservicesApiDeploymentStageprod4C2D8015"
                    },
                    "/PUT/users"
                  ]
                ]
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/users/PUT/ApiPermission.ApiStackMicroservicesApi502F81B5.PUT..users"
            }
          },
          "MicroservicesApiusersPUTApiPermissionTestApiStackMicroservicesApi502F81B5PUTusers4C2B3884": {
            "Type": "AWS::Lambda::Permission",
            "Properties": {
              "Action": "lambda:InvokeFunction",
              "FunctionName": {
                "Fn::GetAtt": [
                  "usersFunctionA84FE85A",
                  "Arn"
                ]
              },
              "Principal": "apigateway.amazonaws.com",
              "SourceArn": {
                "Fn::Join": [
                  "",
                  [
                    "arn:aws:execute-api:eu-central-1:669420849322:",
                    {
                      "Ref": "MicroservicesApiFE627B22"
                    },
                    "/test-invoke-stage/PUT/users"
                  ]
                ]
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/users/PUT/ApiPermission.Test.ApiStackMicroservicesApi502F81B5.PUT..users"
            }
          },
          "MicroservicesApiusersPUT8D1BB6F7": {
            "Type": "AWS::ApiGateway::Method",
            "Properties": {
              "AuthorizationType": "NONE",
              "HttpMethod": "PUT",
              "Integration": {
                "IntegrationHttpMethod": "POST",
                "Type": "AWS_PROXY",
                "Uri": {
                  "Fn::Join": [
                    "",
                    [
                      "arn:aws:apigateway:eu-central-1:lambda:path/2015-03-31/functions/",
                      {
                        "Fn::GetAtt": [
                          "usersFunctionA84FE85A",
                          "Arn"
                        ]
                      },
                      "/invocations"
                    ]
                  ]
                }
              },
              "ResourceId": {
                "Ref": "MicroservicesApiusers5A69665A"
              },
              "RestApiId": {
                "Ref": "MicroservicesApiFE627B22"
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/users/PUT/Resource"
            }
          },
          "MicroservicesApiusersDELETEApiPermissionApiStackMicroservicesApi502F81B5DELETEusers3D70355A": {
            "Type": "AWS::Lambda::Permission",
            "Properties": {
              "Action": "lambda:InvokeFunction",
              "FunctionName": {
                "Fn::GetAtt": [
                  "usersFunctionA84FE85A",
                  "Arn"
                ]
              },
              "Principal": "apigateway.amazonaws.com",
              "SourceArn": {
                "Fn::Join": [
                  "",
                  [
                    "arn:aws:execute-api:eu-central-1:669420849322:",
                    {
                      "Ref": "MicroservicesApiFE627B22"
                    },
                    "/",
                    {
                      "Ref": "MicroservicesApiDeploymentStageprod4C2D8015"
                    },
                    "/DELETE/users"
                  ]
                ]
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/users/DELETE/ApiPermission.ApiStackMicroservicesApi502F81B5.DELETE..users"
            }
          },
          "MicroservicesApiusersDELETEApiPermissionTestApiStackMicroservicesApi502F81B5DELETEusers4CE87721": {
            "Type": "AWS::Lambda::Permission",
            "Properties": {
              "Action": "lambda:InvokeFunction",
              "FunctionName": {
                "Fn::GetAtt": [
                  "usersFunctionA84FE85A",
                  "Arn"
                ]
              },
              "Principal": "apigateway.amazonaws.com",
              "SourceArn": {
                "Fn::Join": [
                  "",
                  [
                    "arn:aws:execute-api:eu-central-1:669420849322:",
                    {
                      "Ref": "MicroservicesApiFE627B22"
                    },
                    "/test-invoke-stage/DELETE/users"
                  ]
                ]
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/users/DELETE/ApiPermission.Test.ApiStackMicroservicesApi502F81B5.DELETE..users"
            }
          },
          "MicroservicesApiusersDELETEF3258329": {
            "Type": "AWS::ApiGateway::Method",
            "Properties": {
              "AuthorizationType": "NONE",
              "HttpMethod": "DELETE",
              "Integration": {
                "IntegrationHttpMethod": "POST",
                "Type": "AWS_PROXY",
                "Uri": {
                  "Fn::Join": [
                    "",
                    [
                      "arn:aws:apigateway:eu-central-1:lambda:path/2015-03-31/functions/",
                      {
                        "Fn::GetAtt": [
                          "usersFunctionA84FE85A",
                          "Arn"
                        ]
                      },
                      "/invocations"
                    ]
                  ]
                }
              },
              "ResourceId": {
                "Ref": "MicroservicesApiusers5A69665A"
              },
              "RestApiId": {
                "Ref": "MicroservicesApiFE627B22"
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/users/DELETE/Resource"
            }
          },
          "MicroservicesApiproductsEF6644D3": {
            "Type": "AWS::ApiGateway::Resource",
            "Properties": {
              "ParentId": {
                "Fn::GetAtt": [
                  "MicroservicesApiFE627B22",
                  "RootResourceId"
                ]
              },
              "PathPart": "products",
              "RestApiId": {
                "Ref": "MicroservicesApiFE627B22"
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/products/Resource"
            }
          },
          "MicroservicesApiproductsOPTIONS9CBB9DAF": {
            "Type": "AWS::ApiGateway::Method",
            "Properties": {
              "ApiKeyRequired": false,
              "AuthorizationType": "NONE",
              "HttpMethod": "OPTIONS",
              "Integration": {
                "IntegrationResponses": [
                  {
                    "ResponseParameters": {
                      "method.response.header.Access-Control-Allow-Headers": "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Amz-User-Agent'",
                      "method.response.header.Access-Control-Allow-Origin": "'*'",
                      "method.response.header.Access-Control-Allow-Methods": "'OPTIONS,GET,PUT,POST,DELETE,PATCH,HEAD'"
                    },
                    "StatusCode": "204"
                  }
                ],
                "RequestTemplates": {
                  "application/json": "{ statusCode: 200 }"
                },
                "Type": "MOCK"
              },
              "MethodResponses": [
                {
                  "ResponseParameters": {
                    "method.response.header.Access-Control-Allow-Headers": true,
                    "method.response.header.Access-Control-Allow-Origin": true,
                    "method.response.header.Access-Control-Allow-Methods": true
                  },
                  "StatusCode": "204"
                }
              ],
              "ResourceId": {
                "Ref": "MicroservicesApiproductsEF6644D3"
              },
              "RestApiId": {
                "Ref": "MicroservicesApiFE627B22"
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/products/OPTIONS/Resource"
            }
          },
          "MicroservicesApiproductsGETApiPermissionApiStackMicroservicesApi502F81B5GETproductsC3E4186A": {
            "Type": "AWS::Lambda::Permission",
            "Properties": {
              "Action": "lambda:InvokeFunction",
              "FunctionName": {
                "Fn::GetAtt": [
                  "productsFunctionC4182BE6",
                  "Arn"
                ]
              },
              "Principal": "apigateway.amazonaws.com",
              "SourceArn": {
                "Fn::Join": [
                  "",
                  [
                    "arn:aws:execute-api:eu-central-1:669420849322:",
                    {
                      "Ref": "MicroservicesApiFE627B22"
                    },
                    "/",
                    {
                      "Ref": "MicroservicesApiDeploymentStageprod4C2D8015"
                    },
                    "/GET/products"
                  ]
                ]
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/products/GET/ApiPermission.ApiStackMicroservicesApi502F81B5.GET..products"
            }
          },
          "MicroservicesApiproductsGETApiPermissionTestApiStackMicroservicesApi502F81B5GETproducts94966CCC": {
            "Type": "AWS::Lambda::Permission",
            "Properties": {
              "Action": "lambda:InvokeFunction",
              "FunctionName": {
                "Fn::GetAtt": [
                  "productsFunctionC4182BE6",
                  "Arn"
                ]
              },
              "Principal": "apigateway.amazonaws.com",
              "SourceArn": {
                "Fn::Join": [
                  "",
                  [
                    "arn:aws:execute-api:eu-central-1:669420849322:",
                    {
                      "Ref": "MicroservicesApiFE627B22"
                    },
                    "/test-invoke-stage/GET/products"
                  ]
                ]
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/products/GET/ApiPermission.Test.ApiStackMicroservicesApi502F81B5.GET..products"
            }
          },
          "MicroservicesApiproductsGETB90AB035": {
            "Type": "AWS::ApiGateway::Method",
            "Properties": {
              "AuthorizationType": "NONE",
              "HttpMethod": "GET",
              "Integration": {
                "IntegrationHttpMethod": "POST",
                "Type": "AWS_PROXY",
                "Uri": {
                  "Fn::Join": [
                    "",
                    [
                      "arn:aws:apigateway:eu-central-1:lambda:path/2015-03-31/functions/",
                      {
                        "Fn::GetAtt": [
                          "productsFunctionC4182BE6",
                          "Arn"
                        ]
                      },
                      "/invocations"
                    ]
                  ]
                }
              },
              "ResourceId": {
                "Ref": "MicroservicesApiproductsEF6644D3"
              },
              "RestApiId": {
                "Ref": "MicroservicesApiFE627B22"
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/products/GET/Resource"
            }
          },
          "MicroservicesApiproductsPOSTApiPermissionApiStackMicroservicesApi502F81B5POSTproductsA3C755C3": {
            "Type": "AWS::Lambda::Permission",
            "Properties": {
              "Action": "lambda:InvokeFunction",
              "FunctionName": {
                "Fn::GetAtt": [
                  "productsFunctionC4182BE6",
                  "Arn"
                ]
              },
              "Principal": "apigateway.amazonaws.com",
              "SourceArn": {
                "Fn::Join": [
                  "",
                  [
                    "arn:aws:execute-api:eu-central-1:669420849322:",
                    {
                      "Ref": "MicroservicesApiFE627B22"
                    },
                    "/",
                    {
                      "Ref": "MicroservicesApiDeploymentStageprod4C2D8015"
                    },
                    "/POST/products"
                  ]
                ]
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/products/POST/ApiPermission.ApiStackMicroservicesApi502F81B5.POST..products"
            }
          },
          "MicroservicesApiproductsPOSTApiPermissionTestApiStackMicroservicesApi502F81B5POSTproducts5C6385C3": {
            "Type": "AWS::Lambda::Permission",
            "Properties": {
              "Action": "lambda:InvokeFunction",
              "FunctionName": {
                "Fn::GetAtt": [
                  "productsFunctionC4182BE6",
                  "Arn"
                ]
              },
              "Principal": "apigateway.amazonaws.com",
              "SourceArn": {
                "Fn::Join": [
                  "",
                  [
                    "arn:aws:execute-api:eu-central-1:669420849322:",
                    {
                      "Ref": "MicroservicesApiFE627B22"
                    },
                    "/test-invoke-stage/POST/products"
                  ]
                ]
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/products/POST/ApiPermission.Test.ApiStackMicroservicesApi502F81B5.POST..products"
            }
          },
          "MicroservicesApiproductsPOSTB66C1ACB": {
            "Type": "AWS::ApiGateway::Method",
            "Properties": {
              "AuthorizationType": "NONE",
              "HttpMethod": "POST",
              "Integration": {
                "IntegrationHttpMethod": "POST",
                "Type": "AWS_PROXY",
                "Uri": {
                  "Fn::Join": [
                    "",
                    [
                      "arn:aws:apigateway:eu-central-1:lambda:path/2015-03-31/functions/",
                      {
                        "Fn::GetAtt": [
                          "productsFunctionC4182BE6",
                          "Arn"
                        ]
                      },
                      "/invocations"
                    ]
                  ]
                }
              },
              "ResourceId": {
                "Ref": "MicroservicesApiproductsEF6644D3"
              },
              "RestApiId": {
                "Ref": "MicroservicesApiFE627B22"
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/products/POST/Resource"
            }
          },
          "MicroservicesApiproductsPUTApiPermissionApiStackMicroservicesApi502F81B5PUTproducts43A9FC62": {
            "Type": "AWS::Lambda::Permission",
            "Properties": {
              "Action": "lambda:InvokeFunction",
              "FunctionName": {
                "Fn::GetAtt": [
                  "productsFunctionC4182BE6",
                  "Arn"
                ]
              },
              "Principal": "apigateway.amazonaws.com",
              "SourceArn": {
                "Fn::Join": [
                  "",
                  [
                    "arn:aws:execute-api:eu-central-1:669420849322:",
                    {
                      "Ref": "MicroservicesApiFE627B22"
                    },
                    "/",
                    {
                      "Ref": "MicroservicesApiDeploymentStageprod4C2D8015"
                    },
                    "/PUT/products"
                  ]
                ]
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/products/PUT/ApiPermission.ApiStackMicroservicesApi502F81B5.PUT..products"
            }
          },
          "MicroservicesApiproductsPUTApiPermissionTestApiStackMicroservicesApi502F81B5PUTproducts4DB3E983": {
            "Type": "AWS::Lambda::Permission",
            "Properties": {
              "Action": "lambda:InvokeFunction",
              "FunctionName": {
                "Fn::GetAtt": [
                  "productsFunctionC4182BE6",
                  "Arn"
                ]
              },
              "Principal": "apigateway.amazonaws.com",
              "SourceArn": {
                "Fn::Join": [
                  "",
                  [
                    "arn:aws:execute-api:eu-central-1:669420849322:",
                    {
                      "Ref": "MicroservicesApiFE627B22"
                    },
                    "/test-invoke-stage/PUT/products"
                  ]
                ]
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/products/PUT/ApiPermission.Test.ApiStackMicroservicesApi502F81B5.PUT..products"
            }
          },
          "MicroservicesApiproductsPUTE97F97AA": {
            "Type": "AWS::ApiGateway::Method",
            "Properties": {
              "AuthorizationType": "NONE",
              "HttpMethod": "PUT",
              "Integration": {
                "IntegrationHttpMethod": "POST",
                "Type": "AWS_PROXY",
                "Uri": {
                  "Fn::Join": [
                    "",
                    [
                      "arn:aws:apigateway:eu-central-1:lambda:path/2015-03-31/functions/",
                      {
                        "Fn::GetAtt": [
                          "productsFunctionC4182BE6",
                          "Arn"
                        ]
                      },
                      "/invocations"
                    ]
                  ]
                }
              },
              "ResourceId": {
                "Ref": "MicroservicesApiproductsEF6644D3"
              },
              "RestApiId": {
                "Ref": "MicroservicesApiFE627B22"
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/products/PUT/Resource"
            }
          },
          "MicroservicesApiproductsDELETEApiPermissionApiStackMicroservicesApi502F81B5DELETEproductsF8DB5CB5": {
            "Type": "AWS::Lambda::Permission",
            "Properties": {
              "Action": "lambda:InvokeFunction",
              "FunctionName": {
                "Fn::GetAtt": [
                  "productsFunctionC4182BE6",
                  "Arn"
                ]
              },
              "Principal": "apigateway.amazonaws.com",
              "SourceArn": {
                "Fn::Join": [
                  "",
                  [
                    "arn:aws:execute-api:eu-central-1:669420849322:",
                    {
                      "Ref": "MicroservicesApiFE627B22"
                    },
                    "/",
                    {
                      "Ref": "MicroservicesApiDeploymentStageprod4C2D8015"
                    },
                    "/DELETE/products"
                  ]
                ]
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/products/DELETE/ApiPermission.ApiStackMicroservicesApi502F81B5.DELETE..products"
            }
          },
          "MicroservicesApiproductsDELETEApiPermissionTestApiStackMicroservicesApi502F81B5DELETEproducts9D60FB1F": {
            "Type": "AWS::Lambda::Permission",
            "Properties": {
              "Action": "lambda:InvokeFunction",
              "FunctionName": {
                "Fn::GetAtt": [
                  "productsFunctionC4182BE6",
                  "Arn"
                ]
              },
              "Principal": "apigateway.amazonaws.com",
              "SourceArn": {
                "Fn::Join": [
                  "",
                  [
                    "arn:aws:execute-api:eu-central-1:669420849322:",
                    {
                      "Ref": "MicroservicesApiFE627B22"
                    },
                    "/test-invoke-stage/DELETE/products"
                  ]
                ]
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/products/DELETE/ApiPermission.Test.ApiStackMicroservicesApi502F81B5.DELETE..products"
            }
          },
          "MicroservicesApiproductsDELETE7CCC64C1": {
            "Type": "AWS::ApiGateway::Method",
            "Properties": {
              "AuthorizationType": "NONE",
              "HttpMethod": "DELETE",
              "Integration": {
                "IntegrationHttpMethod": "POST",
                "Type": "AWS_PROXY",
                "Uri": {
                  "Fn::Join": [
                    "",
                    [
                      "arn:aws:apigateway:eu-central-1:lambda:path/2015-03-31/functions/",
                      {
                        "Fn::GetAtt": [
                          "productsFunctionC4182BE6",
                          "Arn"
                        ]
                      },
                      "/invocations"
                    ]
                  ]
                }
              },
              "ResourceId": {
                "Ref": "MicroservicesApiproductsEF6644D3"
              },
              "RestApiId": {
                "Ref": "MicroservicesApiFE627B22"
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/products/DELETE/Resource"
            }
          },
          "MicroservicesApiorders32EBBB69": {
            "Type": "AWS::ApiGateway::Resource",
            "Properties": {
              "ParentId": {
                "Fn::GetAtt": [
                  "MicroservicesApiFE627B22",
                  "RootResourceId"
                ]
              },
              "PathPart": "orders",
              "RestApiId": {
                "Ref": "MicroservicesApiFE627B22"
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/orders/Resource"
            }
          },
          "MicroservicesApiordersOPTIONSB8B41997": {
            "Type": "AWS::ApiGateway::Method",
            "Properties": {
              "ApiKeyRequired": false,
              "AuthorizationType": "NONE",
              "HttpMethod": "OPTIONS",
              "Integration": {
                "IntegrationResponses": [
                  {
                    "ResponseParameters": {
                      "method.response.header.Access-Control-Allow-Headers": "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Amz-User-Agent'",
                      "method.response.header.Access-Control-Allow-Origin": "'*'",
                      "method.response.header.Access-Control-Allow-Methods": "'OPTIONS,GET,PUT,POST,DELETE,PATCH,HEAD'"
                    },
                    "StatusCode": "204"
                  }
                ],
                "RequestTemplates": {
                  "application/json": "{ statusCode: 200 }"
                },
                "Type": "MOCK"
              },
              "MethodResponses": [
                {
                  "ResponseParameters": {
                    "method.response.header.Access-Control-Allow-Headers": true,
                    "method.response.header.Access-Control-Allow-Origin": true,
                    "method.response.header.Access-Control-Allow-Methods": true
                  },
                  "StatusCode": "204"
                }
              ],
              "ResourceId": {
                "Ref": "MicroservicesApiorders32EBBB69"
              },
              "RestApiId": {
                "Ref": "MicroservicesApiFE627B22"
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/orders/OPTIONS/Resource"
            }
          },
          "MicroservicesApiordersGETApiPermissionApiStackMicroservicesApi502F81B5GETorders11EE28A6": {
            "Type": "AWS::Lambda::Permission",
            "Properties": {
              "Action": "lambda:InvokeFunction",
              "FunctionName": {
                "Fn::GetAtt": [
                  "ordersFunction3ED8FDBE",
                  "Arn"
                ]
              },
              "Principal": "apigateway.amazonaws.com",
              "SourceArn": {
                "Fn::Join": [
                  "",
                  [
                    "arn:aws:execute-api:eu-central-1:669420849322:",
                    {
                      "Ref": "MicroservicesApiFE627B22"
                    },
                    "/",
                    {
                      "Ref": "MicroservicesApiDeploymentStageprod4C2D8015"
                    },
                    "/GET/orders"
                  ]
                ]
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/orders/GET/ApiPermission.ApiStackMicroservicesApi502F81B5.GET..orders"
            }
          },
          "MicroservicesApiordersGETApiPermissionTestApiStackMicroservicesApi502F81B5GETorders872D0B85": {
            "Type": "AWS::Lambda::Permission",
            "Properties": {
              "Action": "lambda:InvokeFunction",
              "FunctionName": {
                "Fn::GetAtt": [
                  "ordersFunction3ED8FDBE",
                  "Arn"
                ]
              },
              "Principal": "apigateway.amazonaws.com",
              "SourceArn": {
                "Fn::Join": [
                  "",
                  [
                    "arn:aws:execute-api:eu-central-1:669420849322:",
                    {
                      "Ref": "MicroservicesApiFE627B22"
                    },
                    "/test-invoke-stage/GET/orders"
                  ]
                ]
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/orders/GET/ApiPermission.Test.ApiStackMicroservicesApi502F81B5.GET..orders"
            }
          },
          "MicroservicesApiordersGETEBC6F451": {
            "Type": "AWS::ApiGateway::Method",
            "Properties": {
              "AuthorizationType": "NONE",
              "HttpMethod": "GET",
              "Integration": {
                "IntegrationHttpMethod": "POST",
                "Type": "AWS_PROXY",
                "Uri": {
                  "Fn::Join": [
                    "",
                    [
                      "arn:aws:apigateway:eu-central-1:lambda:path/2015-03-31/functions/",
                      {
                        "Fn::GetAtt": [
                          "ordersFunction3ED8FDBE",
                          "Arn"
                        ]
                      },
                      "/invocations"
                    ]
                  ]
                }
              },
              "ResourceId": {
                "Ref": "MicroservicesApiorders32EBBB69"
              },
              "RestApiId": {
                "Ref": "MicroservicesApiFE627B22"
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/orders/GET/Resource"
            }
          },
          "MicroservicesApiordersPOSTApiPermissionApiStackMicroservicesApi502F81B5POSTorders7A25E1DE": {
            "Type": "AWS::Lambda::Permission",
            "Properties": {
              "Action": "lambda:InvokeFunction",
              "FunctionName": {
                "Fn::GetAtt": [
                  "ordersFunction3ED8FDBE",
                  "Arn"
                ]
              },
              "Principal": "apigateway.amazonaws.com",
              "SourceArn": {
                "Fn::Join": [
                  "",
                  [
                    "arn:aws:execute-api:eu-central-1:669420849322:",
                    {
                      "Ref": "MicroservicesApiFE627B22"
                    },
                    "/",
                    {
                      "Ref": "MicroservicesApiDeploymentStageprod4C2D8015"
                    },
                    "/POST/orders"
                  ]
                ]
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/orders/POST/ApiPermission.ApiStackMicroservicesApi502F81B5.POST..orders"
            }
          },
          "MicroservicesApiordersPOSTApiPermissionTestApiStackMicroservicesApi502F81B5POSTordersB99DBD1C": {
            "Type": "AWS::Lambda::Permission",
            "Properties": {
              "Action": "lambda:InvokeFunction",
              "FunctionName": {
                "Fn::GetAtt": [
                  "ordersFunction3ED8FDBE",
                  "Arn"
                ]
              },
              "Principal": "apigateway.amazonaws.com",
              "SourceArn": {
                "Fn::Join": [
                  "",
                  [
                    "arn:aws:execute-api:eu-central-1:669420849322:",
                    {
                      "Ref": "MicroservicesApiFE627B22"
                    },
                    "/test-invoke-stage/POST/orders"
                  ]
                ]
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/orders/POST/ApiPermission.Test.ApiStackMicroservicesApi502F81B5.POST..orders"
            }
          },
          "MicroservicesApiordersPOST3347A41E": {
            "Type": "AWS::ApiGateway::Method",
            "Properties": {
              "AuthorizationType": "NONE",
              "HttpMethod": "POST",
              "Integration": {
                "IntegrationHttpMethod": "POST",
                "Type": "AWS_PROXY",
                "Uri": {
                  "Fn::Join": [
                    "",
                    [
                      "arn:aws:apigateway:eu-central-1:lambda:path/2015-03-31/functions/",
                      {
                        "Fn::GetAtt": [
                          "ordersFunction3ED8FDBE",
                          "Arn"
                        ]
                      },
                      "/invocations"
                    ]
                  ]
                }
              },
              "ResourceId": {
                "Ref": "MicroservicesApiorders32EBBB69"
              },
              "RestApiId": {
                "Ref": "MicroservicesApiFE627B22"
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/orders/POST/Resource"
            }
          },
          "MicroservicesApiordersPUTApiPermissionApiStackMicroservicesApi502F81B5PUTorders8D074865": {
            "Type": "AWS::Lambda::Permission",
            "Properties": {
              "Action": "lambda:InvokeFunction",
              "FunctionName": {
                "Fn::GetAtt": [
                  "ordersFunction3ED8FDBE",
                  "Arn"
                ]
              },
              "Principal": "apigateway.amazonaws.com",
              "SourceArn": {
                "Fn::Join": [
                  "",
                  [
                    "arn:aws:execute-api:eu-central-1:669420849322:",
                    {
                      "Ref": "MicroservicesApiFE627B22"
                    },
                    "/",
                    {
                      "Ref": "MicroservicesApiDeploymentStageprod4C2D8015"
                    },
                    "/PUT/orders"
                  ]
                ]
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/orders/PUT/ApiPermission.ApiStackMicroservicesApi502F81B5.PUT..orders"
            }
          },
          "MicroservicesApiordersPUTApiPermissionTestApiStackMicroservicesApi502F81B5PUTorders8A851286": {
            "Type": "AWS::Lambda::Permission",
            "Properties": {
              "Action": "lambda:InvokeFunction",
              "FunctionName": {
                "Fn::GetAtt": [
                  "ordersFunction3ED8FDBE",
                  "Arn"
                ]
              },
              "Principal": "apigateway.amazonaws.com",
              "SourceArn": {
                "Fn::Join": [
                  "",
                  [
                    "arn:aws:execute-api:eu-central-1:669420849322:",
                    {
                      "Ref": "MicroservicesApiFE627B22"
                    },
                    "/test-invoke-stage/PUT/orders"
                  ]
                ]
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/orders/PUT/ApiPermission.Test.ApiStackMicroservicesApi502F81B5.PUT..orders"
            }
          },
          "MicroservicesApiordersPUT9F9490B0": {
            "Type": "AWS::ApiGateway::Method",
            "Properties": {
              "AuthorizationType": "NONE",
              "HttpMethod": "PUT",
              "Integration": {
                "IntegrationHttpMethod": "POST",
                "Type": "AWS_PROXY",
                "Uri": {
                  "Fn::Join": [
                    "",
                    [
                      "arn:aws:apigateway:eu-central-1:lambda:path/2015-03-31/functions/",
                      {
                        "Fn::GetAtt": [
                          "ordersFunction3ED8FDBE",
                          "Arn"
                        ]
                      },
                      "/invocations"
                    ]
                  ]
                }
              },
              "ResourceId": {
                "Ref": "MicroservicesApiorders32EBBB69"
              },
              "RestApiId": {
                "Ref": "MicroservicesApiFE627B22"
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/orders/PUT/Resource"
            }
          },
          "MicroservicesApiordersDELETEApiPermissionApiStackMicroservicesApi502F81B5DELETEorders8B9F0140": {
            "Type": "AWS::Lambda::Permission",
            "Properties": {
              "Action": "lambda:InvokeFunction",
              "FunctionName": {
                "Fn::GetAtt": [
                  "ordersFunction3ED8FDBE",
                  "Arn"
                ]
              },
              "Principal": "apigateway.amazonaws.com",
              "SourceArn": {
                "Fn::Join": [
                  "",
                  [
                    "arn:aws:execute-api:eu-central-1:669420849322:",
                    {
                      "Ref": "MicroservicesApiFE627B22"
                    },
                    "/",
                    {
                      "Ref": "MicroservicesApiDeploymentStageprod4C2D8015"
                    },
                    "/DELETE/orders"
                  ]
                ]
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/orders/DELETE/ApiPermission.ApiStackMicroservicesApi502F81B5.DELETE..orders"
            }
          },
          "MicroservicesApiordersDELETEApiPermissionTestApiStackMicroservicesApi502F81B5DELETEordersA4F9D6A3": {
            "Type": "AWS::Lambda::Permission",
            "Properties": {
              "Action": "lambda:InvokeFunction",
              "FunctionName": {
                "Fn::GetAtt": [
                  "ordersFunction3ED8FDBE",
                  "Arn"
                ]
              },
              "Principal": "apigateway.amazonaws.com",
              "SourceArn": {
                "Fn::Join": [
                  "",
                  [
                    "arn:aws:execute-api:eu-central-1:669420849322:",
                    {
                      "Ref": "MicroservicesApiFE627B22"
                    },
                    "/test-invoke-stage/DELETE/orders"
                  ]
                ]
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/orders/DELETE/ApiPermission.Test.ApiStackMicroservicesApi502F81B5.DELETE..orders"
            }
          },
          "MicroservicesApiordersDELETE5B2AACFF": {
            "Type": "AWS::ApiGateway::Method",
            "Properties": {
              "AuthorizationType": "NONE",
              "HttpMethod": "DELETE",
              "Integration": {
                "IntegrationHttpMethod": "POST",
                "Type": "AWS_PROXY",
                "Uri": {
                  "Fn::Join": [
                    "",
                    [
                      "arn:aws:apigateway:eu-central-1:lambda:path/2015-03-31/functions/",
                      {
                        "Fn::GetAtt": [
                          "ordersFunction3ED8FDBE",
                          "Arn"
                        ]
                      },
                      "/invocations"
                    ]
                  ]
                }
              },
              "ResourceId": {
                "Ref": "MicroservicesApiorders32EBBB69"
              },
              "RestApiId": {
                "Ref": "MicroservicesApiFE627B22"
              }
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/MicroservicesApi/Default/orders/DELETE/Resource"
            }
          },
          "CDKMetadata": {
            "Type": "AWS::CDK::Metadata",
            "Properties": {
              "Analytics": "v2:deflate64:H4sIAAAAAAAA/+1XS2/bMAz+LdWxUL22hwHNLc0eCPpIkOQWFANjMQ5bW9IkekFm+L8Pku0kXTFgG4quxXIwLJEfKVL6RNrnydnFRXJ6BGt/kqqHk5wWSTVlSB8krP2XSm00FEYtkmoGixznleDwvoUCRU8cCyksOCYmo69wI3qV0DsVb2wYTkVdyxc3vJODpY5B1zKHYqEgqT6VOg2G80qkRnVGrtRMWxcr0CpHF2dh9WcGxrC6OMJ4jK4g78noWhIUSTUxcZ/B+7JAdRlTtI50ShbyfpqaUnPrucEEg37018YiCtCQoRqbnFJCL3rz6pFs03ct9i5EDkrNzLhbokEEm1bLDOlqqHPSuNWJY/EbykMK/zqFSLcQmmzkQbo1mJmgeeLnqVipKQNjgZp9F9KrcxRTbbKsJVjKgHENm6SaoOe+pXklXDPaqyUKbW42IxvOzYcz9gzZrtjUAbGEMueBcX7scJlTtuI9POS5WY8cZRTmDR+C6AZ5ZZTvvKBW1pDmgdFLykoHDVGqWLFCBmLy8fNwdNu/Fndt7WrDlh9iiCHTeSUU+tSR3dJMCrDUVR1kIL2D+21pitS6NhmlkA/VHqkO8rcjj6TYna6cBqZGSnSilgc/UTjaRbCcoDelS/ESPMa7JBuaNlcjqrqexWwbXSsgzZh1tI0Ss3cJSl4ZR99Dk9ufDTvrThTtZ02TjvcCLF3hZoJfS3KoRG8Jucdf4aUoYkgT9NZo35ZUz8ClH+x131Y9BgcFMjrfVdl2b28eeflTJ/KwWS+1WW35+u89HEjzxg7sNXg4kOaNHdjzeIjtvjHY9vt5FX6ad18IFng1BsfbNf9a232pxmXqerdixD59In5Usi25ltooTO79u2/n58nZ++T06N4TnbQ/z8mkef8AKo/6HaIQAAA="
            },
            "Metadata": {
              "aws:cdk:path": "ApiStack/CDKMetadata/Default"
            }
          }
        },
        "Outputs": {
          "MicroservicesApiEndpointF3CA5E7A": {
            "Value": {
              "Fn::Join": [
                "",
                [
                  "https://",
                  {
                    "Ref": "MicroservicesApiFE627B22"
                  },
                  ".execute-api.eu-central-1.",
                  {
                    "Ref": "AWS::URLSuffix"
                  },
                  "/",
                  {
                    "Ref": "MicroservicesApiDeploymentStageprod4C2D8015"
                  },
                  "/"
                ]
              ]
            }
          }
        },
        "Parameters": {
          "BootstrapVersion": {
            "Type": "AWS::SSM::Parameter::Value<String>",
            "Default": "/cdk-bootstrap/hnb659fds/version",
            "Description": "Version of the CDK Bootstrap resources in this environment, automatically retrieved from SSM Parameter Store. [cdk:skip]"
          }
        },
        "Rules": {
          "CheckBootstrapVersion": {
            "Assertions": [
              {
                "Assert": {
                  "Fn::Not": [
                    {
                      "Fn::Contains": [
                        [
                          "1",
                          "2",
                          "3",
                          "4",
                          "5"
                        ],
                        {
                          "Ref": "BootstrapVersion"
                        }
                      ]
                    }
                  ]
                },
                "AssertDescription": "CDK bootstrap stack version 6 required. Please run 'cdk bootstrap' with a recent version of the CDK CLI."
              }
            ]
          }
        }
      };
      const userStack = {
        "Resources": {
          "CDKMetadata": {
            "Type": "AWS::CDK::Metadata",
            "Properties": {
              "Analytics": "v2:deflate64:H4sIAAAAAAAA/zPSM7S01DNQTCwv1k1OydbNyUzSCy5JTM7WyctPSdXLKtYvMzLSMzTTM1DMKs7M1C0qzSvJzE3VC4LQAFAZQjY/AAAA"
            },
            "Metadata": {
              "aws:cdk:path": "Users/CDKMetadata/Default"
            }
          }
        },
        "Parameters": {
          "BootstrapVersion": {
            "Type": "AWS::SSM::Parameter::Value<String>",
            "Default": "/cdk-bootstrap/hnb659fds/version",
            "Description": "Version of the CDK Bootstrap resources in this environment, automatically retrieved from SSM Parameter Store. [cdk:skip]"
          }
        },
        "Rules": {
          "CheckBootstrapVersion": {
            "Assertions": [
              {
                "Assert": {
                  "Fn::Not": [
                    {
                      "Fn::Contains": [
                        [
                          "1",
                          "2",
                          "3",
                          "4",
                          "5"
                        ],
                        {
                          "Ref": "BootstrapVersion"
                        }
                      ]
                    }
                  ]
                },
                "AssertDescription": "CDK bootstrap stack version 6 required. Please run 'cdk bootstrap' with a recent version of the CDK CLI."
              }
            ]
          }
        }
      };

      const graph = parser.parseMultiple([
        {stackId: 'ApiStack', template: apiStack},
        {stackId: 'Users', template: userStack},
      ])

      graph.moveNode(
          {stackId: 'ApiStack', logicalId: 'usersFunctionA84FE85A'},
          {stackId: 'Users', logicalId: 'usersFunctionA84FE85A'},
      );

      const newApiStack = generator.generate(graph, 'ApiStack');
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
