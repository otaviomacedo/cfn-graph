import { CloudFormationTemplate, Resource, EdgeType, Output } from './types';
import { CloudFormationGraph } from './graph';
import { isCrossStackEdge } from './utils';

export class CloudFormationGenerator {
  generate(graph: CloudFormationGraph, stackId?: string, metadata?: Partial<CloudFormationTemplate>): CloudFormationTemplate {
    const template: CloudFormationTemplate = {
      AWSTemplateFormatVersion: metadata?.AWSTemplateFormatVersion || '2010-09-09',
      Resources: {}
    };

    if (metadata?.Description) {
      template.Description = metadata.Description;
    }

    if (metadata?.Parameters) {
      template.Parameters = metadata.Parameters;
    }

    if (metadata?.Outputs) {
      template.Outputs = metadata.Outputs;
    }

    // Get nodes for this stack (or all if no stackId specified)
    const nodes = stackId 
      ? graph.getNodesByStack(stackId)
      : graph.getAllNodes();

    // Generate resources from nodes
    for (const node of nodes) {
      const localId = this.getLocalId(node.id);

      const resource: Resource = {
        Type: node.type,
        Properties: node.properties ? JSON.parse(JSON.stringify(node.properties)) : {}
      };

      if (node.metadata) {
        const { CreationPolicy, DeletionPolicy, UpdatePolicy, UpdateReplacePolicy, ...otherMetadata } = node.metadata;
        
        if (Object.keys(otherMetadata).length > 0) {
          resource.Metadata = otherMetadata;
        }
        if (CreationPolicy) resource.CreationPolicy = CreationPolicy;
        if (DeletionPolicy) resource.DeletionPolicy = DeletionPolicy;
        if (UpdatePolicy) resource.UpdatePolicy = UpdatePolicy;
        if (UpdateReplacePolicy) resource.UpdateReplacePolicy = UpdateReplacePolicy;
      }

      // Add DependsOn from edges (only within same stack)
      const dependencies = graph.getEdges(node.id)
        .filter(edge => 
          edge.from === node.id && 
          edge.type === EdgeType.DEPENDS_ON &&
          !isCrossStackEdge(edge)
        )
        .map(edge => this.getLocalId(edge.to));

      if (dependencies.length > 0) {
        resource.DependsOn = dependencies.length === 1 ? dependencies[0] : dependencies;
      }

      // Apply reference edges to properties
      const refEdges = graph.getEdges(node.id).filter(
        edge => edge.from === node.id && (edge.type === EdgeType.REFERENCE || edge.type === EdgeType.GET_ATT)
      );

      for (const edge of refEdges) {
        if (!edge.path) continue;
        
        const isCrossStack = isCrossStackEdge(edge);
        const targetLocalId = this.getLocalId(edge.to);
        
        let refValue: any;
        if (isCrossStack) {
          const exportName = edge.exportName || this.generateExportName(
            graph.getNode(edge.to)?.stackId || '',
            edge.to,
            edge.attribute
          );
          refValue = { 'Fn::ImportValue': exportName };
        } else {
          refValue = edge.type === EdgeType.GET_ATT
            ? { 'Fn::GetAtt': [targetLocalId, edge.attribute!] }
            : { Ref: targetLocalId };
        }

        this.setValueAtPath(resource.Properties, edge.path, refValue);
      }

      template.Resources[localId] = resource;
    }

    // Generate outputs for cross-stack edges pointing to resources in this stack
    if (stackId) {
      const exportsNeeded = new Map<string, { nodeId: string; attribute?: string }>();
      
      for (const edge of graph.getCrossStackEdges()) {
        if (edge.type === EdgeType.REFERENCE || edge.type === EdgeType.GET_ATT) {
          const targetNode = graph.getNode(edge.to);
          if (targetNode && targetNode.stackId === stackId) {
            const exportName = edge.exportName || this.generateExportName(stackId, edge.to, edge.attribute);
            if (!exportsNeeded.has(exportName)) {
              exportsNeeded.set(exportName, { nodeId: edge.to, attribute: edge.attribute });
            }
          }
        }
      }

      for (const [exportName, { nodeId, attribute }] of exportsNeeded) {
        template.Outputs = template.Outputs || {};
        const localId = this.getLocalId(nodeId);
        const outputId = attribute ? `${localId}${attribute}` : localId;
        
        const outputValue = attribute 
          ? { 'Fn::GetAtt': [localId, attribute] }
          : { Ref: localId };
        
        template.Outputs[outputId] = {
          Value: outputValue,
          Export: { Name: exportName }
        };
      }
    }

    return template;
  }

  private setValueAtPath(obj: any, path: string, value: any): void {
    // Remove $.Properties prefix if present
    const cleanPath = path.startsWith('$.Properties.') ? path.substring('$.Properties.'.length) : path;
    if (!cleanPath) return;
    
    const parts = cleanPath.split('.');
    let current = obj;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const arrayMatch = part.match(/^(.+)\[(\d+)\]$/);
      
      if (arrayMatch) {
        const key = arrayMatch[1];
        const index = parseInt(arrayMatch[2], 10);
        current = current[key][index];
      } else {
        current = current[part];
      }
    }

    const lastPart = parts[parts.length - 1];
    const arrayMatch = lastPart.match(/^(.+)\[(\d+)\]$/);
    
    if (arrayMatch) {
      const key = arrayMatch[1];
      const index = parseInt(arrayMatch[2], 10);
      current[key][index] = value;
    } else {
      current[lastPart] = value;
    }
  }

  generateMultiple(graph: CloudFormationGraph): Map<string, CloudFormationTemplate> {
    const templates = new Map<string, CloudFormationTemplate>();
    
    for (const stackId of graph.getAllStacks()) {
      const template = this.generate(graph, stackId);
      templates.set(stackId, template);
    }

    return templates;
  }

  private generateExportName(stackId: string, nodeId: string, attribute?: string): string {
    const localId = this.getLocalId(nodeId);
    const outputId = attribute ? `${localId}${attribute}` : localId;
    return `${stackId}-${outputId}`;
  }

  private getLocalId(qualifiedId: string): string {
    const parts = qualifiedId.split('.');
    return parts.length > 1 ? parts.slice(1).join('.') : qualifiedId;
  }
}
