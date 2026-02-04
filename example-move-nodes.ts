import { CloudFormationParser, CloudFormationGenerator, parseNodeId, createNodeId } from './src';

// Initial setup with two stacks
const storageStack = {
  AWSTemplateFormatVersion: '2010-09-09',
  Description: 'Storage resources',
  Resources: {
    DataBucket: {
      Type: 'AWS::S3::Bucket',
      Properties: {
        BucketName: 'my-data-bucket'
      }
    },
    LogsBucket: {
      Type: 'AWS::S3::Bucket',
      Properties: {
        BucketName: 'my-logs-bucket'
      }
    },
    Queue: {
      Type: 'AWS::SQS::Queue',
      Properties: {
        QueueName: 'data-queue'
      },
      DependsOn: 'DataBucket'
    }
  },
  Outputs: {
    DataBucketName: {
      Value: { Ref: 'DataBucket' },
      Export: {
        Name: 'StorageStack-DataBucket'
      }
    }
  }
};

const appStack = {
  AWSTemplateFormatVersion: '2010-09-09',
  Description: 'Application resources',
  Resources: {
    Function: {
      Type: 'AWS::Lambda::Function',
      Properties: {
        FunctionName: 'my-function',
        Runtime: 'nodejs18.x',
        Environment: {
          Variables: {
            BUCKET: { 'Fn::ImportValue': 'StorageStack-DataBucket' }
          }
        }
      }
    }
  }
};

const parser = new CloudFormationParser();
const graph = parser.parseMultiple([
  { stackId: 'storage', template: storageStack },
  { stackId: 'app', template: appStack }
]);

console.log('=== Initial State ===\n');
console.log('Storage stack nodes:', graph.getNodesByStack('storage').map(n => parseNodeId(n.id).logicalId));
console.log('App stack nodes:', graph.getNodesByStack('app').map(n => parseNodeId(n.id).logicalId));
console.log();

// Example 1: Rename a node within the same stack
console.log('=== Example 1: Rename LogsBucket to AuditLogsBucket ===\n');
const logsBucketId = createNodeId('storage', 'LogsBucket');
graph.moveNode(logsBucketId, 'storage', 'AuditLogsBucket');

console.log('Storage stack nodes:', graph.getNodesByStack('storage').map(n => parseNodeId(n.id).logicalId));
console.log();

// Example 2: Move Queue from storage stack to app stack
console.log('=== Example 2: Move Queue from storage to app stack ===\n');
const queueId = createNodeId('storage', 'Queue');
console.log('Before move:');
console.log('  Queue dependencies:', graph.getDependencies(queueId));
console.log('  Queue edges:', graph.getEdges(queueId).map(e => ({
  from: parseNodeId(e.from).logicalId,
  to: parseNodeId(e.to).logicalId,
  type: e.type,
  crossStack: e.crossStack
})));

graph.moveNode(queueId, 'app', 'Queue');
const newQueueId = createNodeId('app', 'Queue');

console.log('\nAfter move:');
console.log('  Storage stack nodes:', graph.getNodesByStack('storage').map(n => parseNodeId(n.id).logicalId));
console.log('  App stack nodes:', graph.getNodesByStack('app').map(n => parseNodeId(n.id).logicalId));
console.log('  Queue dependencies:', graph.getDependencies(newQueueId));
console.log('  Queue edges:', graph.getEdges(newQueueId).map(e => ({
  from: parseNodeId(e.from).logicalId,
  to: parseNodeId(e.to).logicalId,
  type: e.type,
  crossStack: e.crossStack
})));
console.log();

// Example 3: Move and rename in one operation
console.log('=== Example 3: Move Function to storage stack and rename to DataProcessor ===\n');
const functionId = createNodeId('app', 'Function');
graph.moveNode(functionId, 'storage', 'DataProcessor');

console.log('Storage stack nodes:', graph.getNodesByStack('storage').map(n => parseNodeId(n.id).logicalId));
console.log('App stack nodes:', graph.getNodesByStack('app').map(n => parseNodeId(n.id).logicalId));
console.log();

// Show cross-stack edges after moves
console.log('=== Cross-Stack Dependencies ===\n');
const crossStackEdges = graph.getCrossStackEdges();
for (const edge of crossStackEdges) {
  const from = parseNodeId(edge.from);
  const to = parseNodeId(edge.to);
  console.log(`  [${from.stackId}] ${from.logicalId} --[${edge.type}]--> [${to.stackId}] ${to.logicalId}`);
}
console.log();

// Generate updated templates
console.log('=== Generated Templates ===\n');
const generator = new CloudFormationGenerator();
const templates = generator.generateMultiple(graph);

for (const [stackId, template] of templates) {
  console.log(`${stackId} stack:`);
  console.log('  Resources:', Object.keys(template.Resources));
  if (template.Outputs) {
    console.log('  Outputs:', Object.keys(template.Outputs));
  }
  console.log();
}

// Example 4: Move a resource with in-stack Ref dependency to create cross-stack reference
console.log('=== Example 4: Converting In-Stack Reference to Cross-Stack Reference ===\n');

// First, let's create a new scenario with clear in-stack dependencies
// Initial setup:
//   [infra stack]
//     MyTopic (SNS Topic)
//     MySubscription (SNS Subscription) --Ref--> MyTopic
//
// After moving MySubscription to services stack:
//   [infra stack]
//     MyTopic
//   [services stack]
//     MySubscription --Ref (cross-stack)--> MyTopic (in infra stack)

const infraStack = {
  AWSTemplateFormatVersion: '2010-09-09',
  Resources: {
    MyTopic: {
      Type: 'AWS::SNS::Topic',
      Properties: {
        TopicName: 'notifications'
      }
    },
    MySubscription: {
      Type: 'AWS::SNS::Subscription',
      Properties: {
        Protocol: 'email',
        TopicArn: { Ref: 'MyTopic' },  // In-stack reference via Ref
        Endpoint: 'admin@example.com'
      }
    }
  }
};

const servicesStack = {
  AWSTemplateFormatVersion: '2010-09-09',
  Resources: {
    ServiceRole: {
      Type: 'AWS::IAM::Role',
      Properties: {
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: []
        }
      }
    }
  }
};

// Parse the new scenario
const graph2 = parser.parseMultiple([
  { stackId: 'infra', template: infraStack },
  { stackId: 'services', template: servicesStack }
]);

console.log('Initial state:');
console.log('  Infra stack:', graph2.getNodesByStack('infra').map(n => parseNodeId(n.id).logicalId));
console.log('  Services stack:', graph2.getNodesByStack('services').map(n => parseNodeId(n.id).logicalId));

const subscriptionId = createNodeId('infra', 'MySubscription');
const topicId = createNodeId('infra', 'MyTopic');

console.log('\nBefore move - MySubscription edges:');
const edgesBefore = graph2.getEdges(subscriptionId);
for (const edge of edgesBefore) {
  const from = parseNodeId(edge.from);
  const to = parseNodeId(edge.to);
  console.log(`  [${from.stackId}] ${from.logicalId} --[${edge.type}]--> [${to.stackId}] ${to.logicalId}`);
  console.log(`    crossStack: ${edge.crossStack || false}`);
}

// Move MySubscription to services stack
console.log('\nMoving MySubscription from infra to services stack...');
graph2.moveNode(subscriptionId, 'services', 'MySubscription');
const newSubscriptionId = createNodeId('services', 'MySubscription');

console.log('\nAfter move:');
console.log('  Infra stack:', graph2.getNodesByStack('infra').map(n => parseNodeId(n.id).logicalId));
console.log('  Services stack:', graph2.getNodesByStack('services').map(n => parseNodeId(n.id).logicalId));

console.log('\nAfter move - MySubscription edges:');
const edgesAfter = graph2.getEdges(newSubscriptionId);
for (const edge of edgesAfter) {
  const from = parseNodeId(edge.from);
  const to = parseNodeId(edge.to);
  console.log(`  [${from.stackId}] ${from.logicalId} --[${edge.type}]--> [${to.stackId}] ${to.logicalId}`);
  console.log(`    crossStack: ${edge.crossStack || false} ← Now a cross-stack reference!`);
}

console.log('\nAll cross-stack edges in graph:');
const allCrossStack = graph2.getCrossStackEdges();
for (const edge of allCrossStack) {
  const from = parseNodeId(edge.from);
  const to = parseNodeId(edge.to);
  console.log(`  [${from.stackId}] ${from.logicalId} --[${edge.type}]--> [${to.stackId}] ${to.logicalId}`);
}

// Check if export was created
console.log('\nExports created:');
for (const [exportName, nodeId] of graph2.getExports()) {
  console.log(`  ${exportName} -> ${nodeId}`);
}

console.log('\n=== Key Insight ===');
console.log('The Ref from MySubscription to MyTopic was originally an in-stack reference.');
console.log('After moving MySubscription to the services stack:');
console.log('  1. A new Export node was created in the infra stack for MyTopic');
console.log('  2. The edge type changed from REFERENCE to IMPORT_VALUE');
console.log('  3. The edge now points to the Export node (not directly to MyTopic)');
console.log('  4. When generating templates, Ref will become Fn::ImportValue');
console.log();

// Generate templates to show the transformation
const generator2 = new CloudFormationGenerator();
const crossStackTemplates = generator2.generateMultiple(graph2);

console.log('=== Generated Infra Stack Template ===');
const infraTemplate = crossStackTemplates.get('infra');
console.log(JSON.stringify(infraTemplate, null, 2));

console.log('\n=== Generated Services Stack Template ===');
const servicesTemplate = crossStackTemplates.get('services');
console.log(JSON.stringify(servicesTemplate, null, 2));

console.log('\n=== Notice ===');
console.log('In the infra stack: MyTopic is now exported');
console.log('In the services stack: MySubscription uses Fn::ImportValue instead of Ref');
console.log();


// // Show full template for storage stack
// console.log('=== Full Storage Stack Template ===');
// console.log(JSON.stringify(templates.get('storage'), null, 2));

// console.log('=== Full App Stack Template ===');
// console.log(JSON.stringify(templates.get('app'), null, 2));
