import { CloudFormationParser, CloudFormationGenerator, EdgeType } from './src';

// Network stack - exports VPC and subnet IDs
const networkStack = {
  AWSTemplateFormatVersion: '2010-09-09',
  Description: 'Network infrastructure',
  Resources: {
    VPC: {
      Type: 'AWS::EC2::VPC',
      Properties: {
        CidrBlock: '10.0.0.0/16'
      }
    },
    PublicSubnet: {
      Type: 'AWS::EC2::Subnet',
      Properties: {
        VpcId: { Ref: 'VPC' },
        CidrBlock: '10.0.1.0/24'
      }
    }
  },
  Outputs: {
    VPCId: {
      Value: { Ref: 'VPC' },
      Export: {
        Name: 'NetworkStack-VPCId'
      }
    },
    SubnetId: {
      Value: { Ref: 'PublicSubnet' },
      Export: {
        Name: 'NetworkStack-SubnetId'
      }
    }
  }
};

// Application stack - imports VPC and subnet from network stack
const appStack = {
  AWSTemplateFormatVersion: '2010-09-09',
  Description: 'Application resources',
  Resources: {
    SecurityGroup: {
      Type: 'AWS::EC2::SecurityGroup',
      Properties: {
        GroupDescription: 'App security group',
        VpcId: { 'Fn::ImportValue': 'NetworkStack-VPCId' }
      }
    },
    Instance: {
      Type: 'AWS::EC2::Instance',
      Properties: {
        InstanceType: 't3.micro',
        SubnetId: { 'Fn::ImportValue': 'NetworkStack-SubnetId' },
        SecurityGroupIds: [{ Ref: 'SecurityGroup' }]
      },
      DependsOn: 'SecurityGroup'
    }
  }
};

// Database stack - also imports VPC
const dbStack = {
  AWSTemplateFormatVersion: '2010-09-09',
  Description: 'Database resources',
  Resources: {
    DBSubnetGroup: {
      Type: 'AWS::RDS::DBSubnetGroup',
      Properties: {
        DBSubnetGroupDescription: 'Subnet group for RDS',
        SubnetIds: [
          { 'Fn::ImportValue': 'NetworkStack-SubnetId' }
        ]
      }
    },
    Database: {
      Type: 'AWS::RDS::DBInstance',
      Properties: {
        Engine: 'postgres',
        DBInstanceClass: 'db.t3.micro',
        DBSubnetGroupName: { Ref: 'DBSubnetGroup' }
      }
    }
  },
  Outputs: {
    DBEndpoint: {
      Value: { 'Fn::GetAtt': ['Database', 'Endpoint.Address'] },
      Export: {
        Name: 'DatabaseStack-Endpoint'
      }
    }
  }
};

// Parse multiple stacks
const parser = new CloudFormationParser();
const graph = parser.parseMultiple([
  { stackId: 'network', template: networkStack },
  { stackId: 'app', template: appStack },
  { stackId: 'database', template: dbStack }
]);

console.log('=== Multi-Stack Graph Analysis ===\n');

// Show all stacks
console.log('Stacks:', graph.getAllStacks());
console.log();

// Show all nodes
console.log('Total nodes:', graph.getAllNodes().length);
for (const stack of graph.getAllStacks()) {
  const nodes = graph.getNodesByStack(stack);
  console.log(`  ${stack}: ${nodes.length} nodes`);
}
console.log();

// Show exports
console.log('Exports:');
for (const [exportName, nodeId] of graph.getExports()) {
  console.log(`  ${exportName} -> ${nodeId}`);
}
console.log();

// Show cross-stack edges
console.log('Cross-stack dependencies:');
const crossStackEdges = graph.getCrossStackEdges();
for (const edge of crossStackEdges) {
  console.log(`  ${edge.from} --[${edge.type}]--> ${edge.to}`);
}
console.log();

// Manipulate the graph - add a new resource to app stack
console.log('Adding LoadBalancer to app stack...');
graph.addNode({
  id: 'app::LoadBalancer',
  type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
  properties: {
    Subnets: [{ 'Fn::ImportValue': 'NetworkStack-SubnetId' }]
  },
  stackId: 'app'
});

// Add dependency
const exportNode = graph.getExportNode('NetworkStack-SubnetId');
if (exportNode) {
  graph.addEdge({
    from: 'app::LoadBalancer',
    to: exportNode,
    type: EdgeType.IMPORT_VALUE,
    crossStack: true
  });
}

console.log('Updated app stack nodes:', graph.getNodesByStack('app').length);
console.log();

// Generate templates back
const generator = new CloudFormationGenerator();
const templates = generator.generateMultiple(graph);

console.log('=== Generated Templates ===\n');
for (const [stackId, template] of templates) {
  console.log(`${stackId} stack:`);
  console.log(JSON.stringify(template, null, 2));
  console.log();
}
