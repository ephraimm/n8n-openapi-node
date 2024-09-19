import {INodeProperties} from 'n8n-workflow/dist/Interfaces';
import {OpenAPIV3} from 'openapi-types';
import pino from 'pino';
import {OpenAPIWalker} from "./openapi/OpenAPIWalker";
import {ResourcePropertiesCollector} from "./ResourcePropertiesCollector";
import {OperationsCollector} from "./OperationsCollector";


export interface ParserConfig {
    logger?: pino.Logger;
    addUriAfterOperation: boolean;
}

export class Parser {
    public resourceNode?: INodeProperties;
    public operations: INodeProperties[];
    public fields: INodeProperties[];

    private logger: pino.Logger
    private readonly addUriAfterOperation: boolean;

    private readonly doc: OpenAPIV3.Document;

    // OpenAPI helpers
    private readonly walker: OpenAPIWalker;

    constructor(doc: any, config?: ParserConfig) {
        this.doc = doc
        this.operations = [];
        this.fields = []

        this.logger = config?.logger || pino()
        this.addUriAfterOperation = config ? config.addUriAfterOperation : true
        this.walker = new OpenAPIWalker(this.doc)
    }

    get properties(): INodeProperties[] {
        if (!this.resourceNode) {
            throw new Error('Resource node not found');
        }
        return [this.resourceNode, ...this.operations, ...this.fields];
    }

    process() {
        this.parseResources();
        this.parseOperations();
    }

    private parseResources() {
        const collector = new ResourcePropertiesCollector(this.logger)
        this.walker.walk(collector)
        this.resourceNode = collector.iNodeProperty
    }

    private parseOperations() {
        const collector = new OperationsCollector(this.logger, this.doc, this.addUriAfterOperation)
        this.walker.walk(collector)
        this.operations = collector.operations
        this.fields = collector.fields
    }
}
