import { CloudFormationTemplate, Resource, EdgeType, Output } from './types';
import { CloudFormationGraph } from './graph';

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
      
      // Transform properties to handle cross-stack references
      const transformedProperties = this.transformProperties(
        node.properties, 
        node.id, 
        graph
      );

      const resource: Resource = {
        Type: node.type,
        Properties: transformedProperties
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
          !edge.crossStack
        )
        .map(edge => this.getLocalId(edge.to));

      if (dependencies.length > 0) {
        resource.DependsOn = dependencies.length === 1 ? dependencies[0] : dependencies;
      }

      template.Resources[localId] = resource;
    }

    // Generate outputs for cross-stack edges pointing to resources in this stack
    if (stackId) {
      const exportsNeeded = new Map<string, { nodeId: string; attribute?: string }>();
      
      for (const edge of graph.getCrossStackEdges()) {
        if (edge.type === EdgeType.IMPORT_VALUE) {
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

  private transformProperties(
    properties: Record<string, any>,
    nodeId: string,
    graph: CloudFormationGraph
  ): Record<string, any> {
    const importEdges = graph.getEdges(nodeId).filter(
      edge => edge.from === nodeId && edge.type === EdgeType.IMPORT_VALUE
    );

    if (importEdges.length === 0) {
      return properties;
    }

    const importMap = new Map<string, string>();
    for (const edge of importEdges) {
      const exportName = edge.exportName || this.generateExportName(
        graph.getNode(edge.to)?.stackId || '',
        edge.to,
        edge.attribute
      );
      
      const key = edge.attribute 
        ? `${this.getLocalId(edge.to)}::${edge.attribute}`
        : this.getLocalId(edge.to);
      
      importMap.set(key, exportName);
    }

    return this.replaceRefs(properties, importMap);
  }

  private replaceRefs(
    obj: any,
    importMap: Map<string, string>
  ): any {
    if (obj === null || obj === undefined) {
      return obj;
    }

    if (typeof obj !== 'object') {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.replaceRefs(item, importMap));
    }

    // Check if this is a Ref that needs to be converted
    if (obj.Ref && typeof obj.Ref === 'string') {
      const exportName = importMap.get(obj.Ref);
      if (exportName) {
        return { 'Fn::ImportValue': exportName };
      }
    }

    // Check if this is a Fn::GetAtt that needs to be converted
    if (obj['Fn::GetAtt']) {
      const attr = obj['Fn::GetAtt'];
      if (Array.isArray(attr) && attr.length >= 2) {
        const target = attr[0];
        const attribute = attr[1];
        
        if (typeof target === 'string') {
          const key = `${target}::${attribute}`;
          const exportName = importMap.get(key);
          if (exportName) {
            return { 'Fn::ImportValue': exportName };
          }
        }
      }
    }

    // Recursively process object properties
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = this.replaceRefs(value, importMap);
    }
    return result;
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
