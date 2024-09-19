import {INodeProperties} from 'n8n-workflow/dist/Interfaces';
import * as lodash from 'lodash';
import {OpenAPIV3} from 'openapi-types';
import pino from 'pino';
import {OpenAPIWalker} from "./openapi/OpenAPIWalker";
import {ResourcePropertiesCollector} from "./ResourcePropertiesCollector";
import {N8NINodeProperties} from "./SchemaToINodeProperties";
import {OperationsCollector} from "./OperationsCollector";

interface Action {
    uri: string;
    method: 'get' | 'post' | 'put' | 'delete' | 'patch';
}

/**
 * /api/entities/{entity} => /api/entities/{{$parameter["entity"]}}
 */
function replaceToParameter(uri: string): string {
    return uri.replace(/{([^}]*)}/g, '{{$parameter["$1"]}}');
}


function sessionFirst(a: any, b: any) {
    if (a.name === 'session') {
        return -1;
    }
    if (b.name === 'session') {
        return 1;
    }
    return 0;
}

export interface ParserConfig {
    logger?: pino.Logger;
    addUriAfterOperation: boolean;
}

export class Parser {
    public resourceNode?: INodeProperties;
    public operations: INodeProperties[];

    private logger: pino.Logger
    private readonly addUriAfterOperation: boolean;

    private readonly doc: OpenAPIV3.Document;

    // OpenAPI helpers
    private readonly walker: OpenAPIWalker;
    private n8nNodeProperties: N8NINodeProperties;

    constructor(doc: any, config?: ParserConfig) {
        this.doc = doc
        this.operations = [];

        this.logger = config?.logger || pino()
        this.addUriAfterOperation = config ? config.addUriAfterOperation : true
        this.walker = new OpenAPIWalker(this.doc)
        this.n8nNodeProperties = new N8NINodeProperties(this.logger, doc)
    }

    get properties(): INodeProperties[] {
        if (!this.resourceNode) {
            throw new Error('Resource node not found');
        }
        return [this.resourceNode, ...this.operations];
    }

    private get paths(): OpenAPIV3.PathsObject {
        return this.doc.paths;
    }

    process() {
        this.parseResources();
        this.parseOperations();
    }

    parse(resource: string, action: Action): INodeProperties[] {
        const fieldNodes: any[] = [];
        const options: any[] = [];
        const ops: OpenAPIV3.PathItemObject = this.paths[action.uri]!!;
        const operation = ops[action.method as OpenAPIV3.HttpMethods]!!;
        const {option, fields} = this.parseOperation(resource, operation, action.uri, action.method);
        options.push(option);
        fieldNodes.push(...fields);

        // eslint-disable-next-line
        const operations = {
            displayName: 'Operation',
            name: 'operation',
            type: 'options',
            noDataExpression: true,
            displayOptions: {
                show: {
                    resource: [resource],
                },
            },
            options: options,
            default: '',
        };

        return [operations, ...fieldNodes] as INodeProperties[];
    }

    parseOperation(
        resourceName: string,
        operation: OpenAPIV3.OperationObject,
        uri: string,
        method: string,
    ) {
        let operationId: string = operation.operationId!!.split('_').slice(1).join('_');
        if (!operationId) {
            operationId = operation.operationId as string
        }

        const operationName = lodash.startCase(operationId);
        const description = operation.description || operation.summary || '';
        const option = {
            name: operationName,
            value: operationName,
            action: operation.summary || operationName,
            description: description,
            routing: {
                request: {
                    method: method.toUpperCase(),
                    url: `=${replaceToParameter(uri)}`,
                },
            },
        };
        const fields = this.parseFields(resourceName, operationName, operation);

        if (this.addUriAfterOperation) {
            const notice = {
                displayName: `${method.toUpperCase()} ${uri}`,
                name: 'operation',
                type: 'notice',
                typeOptions: {
                    theme: 'info',
                },
                displayOptions: {
                    show: {
                        resource: [resourceName],
                        operation: [operationName],
                    },
                },
                default: '',
            };
            // @ts-ignore
            fields.unshift(notice);
        }

        return {
            option: option,
            fields: fields,
        };
    }

    parseFields(resourceName: string, operationName: string, operation: any) {
        const fields = [];
        const parameterFields = this.n8nNodeProperties.fromParameters(operation.parameters)
        fields.push(...parameterFields);
        const bodyFields = this.n8nNodeProperties.fromRequestBody(operation.requestBody)
        fields.push(...bodyFields);

        const displayOptions = {
            show: {
                resource: [resourceName],
                operation: [operationName],
            },
        }
        fields.forEach((field) => {
            field.displayOptions = displayOptions
        })

        // sort fields, so "session" always top
        fields.sort(sessionFirst);
        return fields;
    }

    private parseResources() {
        const collector = new ResourcePropertiesCollector(this.logger)
        this.walker.walk(collector)
        this.resourceNode = collector.iNodeProperty
    }

    private parseOperations() {
        const collector = new OperationsCollector(this.logger, this.doc, this.addUriAfterOperation)
        this.walker.walk(collector)
        this.operations = collector.iNodeProperties
    }
}
