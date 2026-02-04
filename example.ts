import { CloudFormationParser, CloudFormationGenerator, CloudFormationGraph, EdgeType } from './src';

// Example CloudFormation template
const template = {
  AWSTemplateFormatVersion: '2010-09-09',
  Description: 'Example stack with S3 and SQS',
  Resources: {
    MyBucket: {
      Type: 'AWS::S3::Bucket',
      Properties: {
        BucketName: 'my-example-bucket'
      }
    },
    MyQueue: {
      Type: 'AWS::SQS::Queue',
      Properties: {
        QueueName: 'my-queue'
      },
      DependsOn: 'MyBucket'
    },
    MyTopic: {
      Type: 'AWS::SNS::Topic',
      Properties: {
        TopicName: 'my-topic',
        Subscription: [
          {
            Endpoint: { 'Fn::GetAtt': ['MyQueue', 'Arn'] },
            Protocol: 'sqs'
          }
        ]
      }
    }
  }
};

// Parse template to graph
const parser = new CloudFormationParser();
const graph = parser.parse(template);

console.log('Parsed graph:');
console.log('Nodes:', graph.getAllNodes().map(n => n.id));
console.log('Edges:', graph.getEdges());

// Manipulate the graph
console.log('\nAdding a new Lambda function...');
graph.addNode({
  id: 'MyFunction',
  type: 'AWS::Lambda::Function',
  properties: {
    FunctionName: 'my-function',
    Runtime: 'nodejs18.x',
    Handler: 'index.handler'
  }
});

graph.addEdge({
  from: 'MyFunction',
  to: 'MyBucket',
  type: EdgeType.DEPENDS_ON
});

console.log('Updated nodes:', graph.getAllNodes().map(n => n.id));

// Generate new template
const generator = new CloudFormationGenerator();
const newTemplate = generator.generate(graph, {
  Description: 'Modified stack with Lambda'
});

console.log('\nGenerated template:');
console.log(JSON.stringify(newTemplate, null, 2));
