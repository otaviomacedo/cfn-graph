import { CloudFormationTemplate, Resource, GraphNode, GraphEdge, EdgeType, StackTemplate, Output } from './types';
import { CloudFormationGraph } from './graph';

export class CloudFormationParser {
  parse(template: CloudFormationTemplate, stackId: string = 'default'): CloudFormationGraph {
    const graph = new CloudFormationGraph();
    const exportMap = new Map<string, { nodeId: string; attribute?: string }>();

    // Add nodes for each resource
    for (const [resourceId, resource] of Object.entries(template.Resources)) {
      const node: GraphNode = {
        id: this.getQualifiedId(stackId, resourceId),
        type: resource.Type,
        properties: resource.Properties || {},
        metadata: {
          ...resource.Metadata,
          ...(resource.CreationPolicy && { CreationPolicy: resource.CreationPolicy }),
          ...(resource.DeletionPolicy && { DeletionPolicy: resource.DeletionPolicy }),
          ...(resource.UpdatePolicy && { UpdatePolicy: resource.UpdatePolicy }),
          ...(resource.UpdateReplacePolicy && { UpdateReplacePolicy: resource.UpdateReplacePolicy })
        },
        stackId
      };
      graph.addNode(node);
    }

    // Build export map from outputs
    if (template.Outputs) {
      for (const [outputId, output] of Object.entries(template.Outputs)) {
        if (output.Export) {
          const exportName = this.resolveExportName(output.Export.Name);
          const sourceRefs = this.findReferences(output.Value);
          const sourceGetAtts = this.findGetAtts(output.Value);
          
          if (sourceRefs.length > 0) {
            const sourceId = this.getQualifiedId(stackId, sourceRefs[0]);
            exportMap.set(exportName, { nodeId: sourceId });
          } else if (sourceGetAtts.length > 0) {
            const sourceId = this.getQualifiedId(stackId, sourceGetAtts[0].target);
            exportMap.set(exportName, { nodeId: sourceId, attribute: sourceGetAtts[0].attribute });
          }
        }
      }
    }

    // Add edges for dependencies
    for (const [resourceId, resource] of Object.entries(template.Resources)) {
      const qualifiedId = this.getQualifiedId(stackId, resourceId);
      this.extractDependencies(qualifiedId, resource, graph, stackId);
      this.extractReferences(qualifiedId, resource, graph, stackId);
      this.extractImports(qualifiedId, resource, graph, exportMap);
    }

    return graph;
  }

  parseMultiple(stacks: StackTemplate[]): CloudFormationGraph {
    const graph = new CloudFormationGraph();
    const exportMap = new Map<string, { nodeId: string; attribute?: string }>();

    // First pass: parse each template and build export map
    for (const { stackId, template } of stacks) {
      // Add nodes
      for (const [resourceId, resource] of Object.entries(template.Resources)) {
        const node: GraphNode = {
          id: this.getQualifiedId(stackId, resourceId),
          type: resource.Type,
          properties: resource.Properties || {},
          metadata: {
            ...resource.Metadata,
            ...(resource.CreationPolicy && { CreationPolicy: resource.CreationPolicy }),
            ...(resource.DeletionPolicy && { DeletionPolicy: resource.DeletionPolicy }),
            ...(resource.UpdatePolicy && { UpdatePolicy: resource.UpdatePolicy }),
            ...(resource.UpdateReplacePolicy && { UpdateReplacePolicy: resource.UpdateReplacePolicy })
          },
          stackId
        };
        graph.addNode(node);
      }

      // Build export map
      if (template.Outputs) {
        for (const [outputId, output] of Object.entries(template.Outputs)) {
          if (output.Export) {
            const exportName = this.resolveExportName(output.Export.Name);
            const sourceRefs = this.findReferences(output.Value);
            const sourceGetAtts = this.findGetAtts(output.Value);
            
            if (sourceRefs.length > 0) {
              const sourceId = this.getQualifiedId(stackId, sourceRefs[0]);
              exportMap.set(exportName, { nodeId: sourceId });
            } else if (sourceGetAtts.length > 0) {
              const sourceId = this.getQualifiedId(stackId, sourceGetAtts[0].target);
              exportMap.set(exportName, { nodeId: sourceId, attribute: sourceGetAtts[0].attribute });
            }
          }
        }
      }
    }

    // Second pass: add edges
    for (const { stackId, template } of stacks) {
      for (const [resourceId, resource] of Object.entries(template.Resources)) {
        const qualifiedId = this.getQualifiedId(stackId, resourceId);
        this.extractDependencies(qualifiedId, resource, graph, stackId);
        this.extractReferences(qualifiedId, resource, graph, stackId);
        this.extractImports(qualifiedId, resource, graph, exportMap);
      }
    }

    return graph;
  }

  private getQualifiedId(stackId: string, resourceId: string): string {
    return `${stackId}.${resourceId}`;
  }

  private resolveExportName(name: any): string {
    if (typeof name === 'string') return name;
    if (name.Ref) return name.Ref;
    if (name['Fn::Sub']) return name['Fn::Sub'];
    return JSON.stringify(name);
  }

  private extractDependencies(resourceId: string, resource: Resource, graph: CloudFormationGraph, stackId: string): void {
    if (!resource.DependsOn) return;

    const dependencies = Array.isArray(resource.DependsOn) 
      ? resource.DependsOn 
      : [resource.DependsOn];

    for (const dep of dependencies) {
      const qualifiedDep = this.getQualifiedId(stackId, dep);
      graph.addEdge({
        from: resourceId,
        to: qualifiedDep,
        type: EdgeType.DEPENDS_ON
      });
    }
  }

  private extractReferences(resourceId: string, resource: Resource, graph: CloudFormationGraph, stackId: string): void {
    if (!resource.Properties) return;

    const refs = this.findReferencesWithPath(resource.Properties);
    for (const { ref, path } of refs) {
      const qualifiedRef = this.getQualifiedId(stackId, ref);
      if (graph.getNode(qualifiedRef)) {
        graph.addEdge({
          from: resourceId,
          to: qualifiedRef,
          type: EdgeType.REFERENCE,
          path
        });
      }
    }

    const getAtts = this.findGetAttsWithPath(resource.Properties);
    for (const { target, attribute, path } of getAtts) {
      const qualifiedRef = this.getQualifiedId(stackId, target);
      if (graph.getNode(qualifiedRef)) {
        graph.addEdge({
          from: resourceId,
          to: qualifiedRef,
          type: EdgeType.GET_ATT,
          attribute,
          path
        });
      }
    }
  }

  private extractImports(resourceId: string, resource: Resource, graph: CloudFormationGraph, exportMap: Map<string, { nodeId: string; attribute?: string }>): void {
    if (!resource.Properties) return;

    const imports = this.findImportsWithPath(resource.Properties);
    for (const { importName, path } of imports) {
      const exportInfo = exportMap.get(importName);
      if (exportInfo) {
        graph.addEdge({
          from: resourceId,
          to: exportInfo.nodeId,
          type: EdgeType.IMPORT_VALUE,
          path,
          exportName: importName,
          attribute: exportInfo.attribute
        });
      }
    }
  }

  private findReferences(obj: any, refs: Set<string> = new Set()): string[] {
    if (typeof obj !== 'object' || obj === null) return Array.from(refs);

    if (obj.Ref && typeof obj.Ref === 'string') {
      refs.add(obj.Ref);
    }

    for (const value of Object.values(obj)) {
      this.findReferences(value, refs);
    }

    return Array.from(refs);
  }

  private findReferencesWithPath(obj: any, currentPath: string = '$.Properties', results: Array<{ ref: string; path: string }> = []): Array<{ ref: string; path: string }> {
    if (typeof obj !== 'object' || obj === null) return results;

    if (obj.Ref && typeof obj.Ref === 'string') {
      results.push({ ref: obj.Ref, path: currentPath });
    }

    for (const [key, value] of Object.entries(obj)) {
      this.findReferencesWithPath(value, `${currentPath}.${key}`, results);
    }

    return results;
  }

  private findGetAtts(obj: any, getAtts: Array<{ target: string; attribute: string }> = []): Array<{ target: string; attribute: string }> {
    if (typeof obj !== 'object' || obj === null) return getAtts;

    if (obj['Fn::GetAtt']) {
      const attr = obj['Fn::GetAtt'];
      if (Array.isArray(attr) && attr.length >= 2 && typeof attr[0] === 'string' && typeof attr[1] === 'string') {
        getAtts.push({ target: attr[0], attribute: attr[1] });
      }
    }

    for (const value of Object.values(obj)) {
      this.findGetAtts(value, getAtts);
    }

    return getAtts;
  }

  private findGetAttsWithPath(obj: any, currentPath: string = '$.Properties', results: Array<{ target: string; attribute: string; path: string }> = []): Array<{ target: string; attribute: string; path: string }> {
    if (typeof obj !== 'object' || obj === null) return results;

    if (obj['Fn::GetAtt']) {
      const attr = obj['Fn::GetAtt'];
      if (Array.isArray(attr) && attr.length >= 2 && typeof attr[0] === 'string' && typeof attr[1] === 'string') {
        results.push({ target: attr[0], attribute: attr[1], path: currentPath });
      }
    }

    for (const [key, value] of Object.entries(obj)) {
      this.findGetAttsWithPath(value, `${currentPath}.${key}`, results);
    }

    return results;
  }

  private findImports(obj: any, imports: Set<string> = new Set()): string[] {
    if (typeof obj !== 'object' || obj === null) return Array.from(imports);

    if (obj['Fn::ImportValue']) {
      const importValue = obj['Fn::ImportValue'];
      if (typeof importValue === 'string') {
        imports.add(importValue);
      } else if (typeof importValue === 'object') {
        // Handle complex import values like Fn::Sub
        const resolved = this.resolveExportName(importValue);
        imports.add(resolved);
      }
    }

    for (const value of Object.values(obj)) {
      this.findImports(value, imports);
    }

    return Array.from(imports);
  }

  private findImportsWithPath(obj: any, currentPath: string = '$.Properties', results: Array<{ importName: string; path: string }> = []): Array<{ importName: string; path: string }> {
    if (typeof obj !== 'object' || obj === null) return results;

    if (obj['Fn::ImportValue']) {
      const importValue = obj['Fn::ImportValue'];
      if (typeof importValue === 'string') {
        results.push({ importName: importValue, path: currentPath });
      } else if (typeof importValue === 'object') {
        const resolved = this.resolveExportName(importValue);
        results.push({ importName: resolved, path: currentPath });
      }
    }

    for (const [key, value] of Object.entries(obj)) {
      this.findImportsWithPath(value, `${currentPath}.${key}`, results);
    }

    return results;
  }
}
