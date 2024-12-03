import {OpenAPIV3} from "openapi-types";
import {INodeProperties, NodePropertyTypes} from "n8n-workflow";
import {RefResolver} from "../openapi/RefResolver";
import * as lodash from "lodash";
import {SchemaExample} from "../openapi/SchemaExample";

type Schema = OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject;
type FromSchemaNodeProperty = Pick<INodeProperties, 'type' | 'default' | 'description' | 'options'>;

function combine(...sources: Partial<INodeProperties>[]): INodeProperties {
    const obj = lodash.defaults({}, ...sources)
    if (!obj.required) {
        // n8n does want to have required: false|null|undefined
        delete obj.required
    }
    return obj
}

/**
 * in obj find key starts with regexp
 * Return first match VALUE of the key
 */
function findKey(obj: any, regexp: RegExp): any | undefined {
    const key = Object.keys(obj).find((key) => regexp.test(key))
    return key ? obj[key] : undefined
}

/**
 * One level deep - meaning only top fields of the schema
 * The rest represent as JSON string
 */
export class N8NINodeProperties {
    private refResolver: RefResolver;
    private schemaExample: SchemaExample;

    constructor(doc: any) {
        this.refResolver = new RefResolver(doc)
        this.schemaExample = new SchemaExample(doc)
    }

    fromSchema(schema: Schema): FromSchemaNodeProperty {
        schema = this.refResolver.resolve<OpenAPIV3.SchemaObject>(schema)
        let type: NodePropertyTypes;
        let defaultValue = this.schemaExample.extractExample(schema)

        switch (schema.type) {
            case 'boolean':
                type = 'boolean';
                defaultValue = defaultValue !== undefined ? defaultValue : true;
                break;
            case 'string':
            case undefined:
                type = 'string';
                defaultValue = defaultValue !== undefined ? defaultValue : '';
                break;
            case 'object':
                type = 'json';
                defaultValue = defaultValue !== undefined ? JSON.stringify(defaultValue, null, 2) : '{}';
                break;
            case 'array':
                type = 'json';
                defaultValue = defaultValue !== undefined ? JSON.stringify(defaultValue, null, 2) : '[]';
                break;
            case 'number':
            case 'integer':
                type = 'number';
                defaultValue = defaultValue !== undefined ? defaultValue : 0;
                break;
        }

        const field: FromSchemaNodeProperty = {
            type: type,
            default: defaultValue,
            description: schema.description,
        };
        if (schema.enum && schema.enum.length > 0) {
            field.type = 'options';
            field.options = schema.enum.map((value: string) => {
                return {
                    name: lodash.startCase(value),
                    value: value,
                };
            });
            field.default = field.default ? field.default : schema.enum[0];
        }
        return field;
    }

    fromParameter(parameter: OpenAPIV3.ReferenceObject | OpenAPIV3.ParameterObject): INodeProperties {
        parameter = this.refResolver.resolve<OpenAPIV3.ParameterObject>(parameter)
        const fieldSchemaKeys: FromSchemaNodeProperty = this.fromSchema(parameter.schema!!);
        const fieldParameterKeys: Partial<INodeProperties> = {
            displayName: lodash.startCase(parameter.name),
            name: parameter.name,
            required: parameter.required,
            description: parameter.description,
            default: parameter.example,
        };
        const field = combine(fieldParameterKeys, fieldSchemaKeys)

        switch (parameter.in) {
            case "query":
                field.routing = {
                    request: {
                        qs: {
                            [parameter.name]: '={{ $value }}',
                        },
                    },
                };
                break;
            case "path" :
                field.required = true
                break
            case "header":
                field.routing = {
                    request: {
                        headers: {
                            [parameter.name]: '={{ $value }}',
                        },
                    },
                };
                break
            default:
                throw new Error(`Unknown parameter location '${parameter.in}'`);
        }
        if (!field.required) {
            delete field.required
        }
        return field
    }

    fromParameters(parameters: (OpenAPIV3.ReferenceObject | OpenAPIV3.ParameterObject)[] | undefined): INodeProperties[] {
        if (!parameters) {
            return [];
        }
        const fields = [];
        for (const parameter of parameters) {
            const field = this.fromParameter(parameter)
            fields.push(field);
        }
        return fields;
    }

    fromSchemaProperty(name: string, property: OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject): INodeProperties {
        const fieldSchemaKeys: FromSchemaNodeProperty = this.fromSchema(property)
        const fieldParameterKeys: Partial<INodeProperties> = {
            displayName: lodash.startCase(name),
            name: name,
        }
        const field = combine(fieldParameterKeys, fieldSchemaKeys)
        return field
    }

    fromRequestBody(body: OpenAPIV3.ReferenceObject | OpenAPIV3.RequestBodyObject | undefined): INodeProperties[] {
        if (!body) {
            return [];
        }
        body = this.refResolver.resolve<OpenAPIV3.RequestBodyObject>(body)
        
        // Try multipart/form-data first, then fall back to application/json
        const multipartContent = body.content?.['multipart/form-data'];
        if (multipartContent) {
            return this.fromMultipartFormData(multipartContent);
        }

        const regexp = /application\/json.*/
        const content = findKey(body.content, regexp)
        if (!content) {
            throw new Error(`No '${regexp}' or multipart/form-data content found`);
        }

        const requestBodySchema = content.schema!!;
        const schema = this.refResolver.resolve<OpenAPIV3.SchemaObject>(requestBodySchema)
        if (!schema.properties && schema.type != 'object' && schema.type != 'array') {
            throw new Error(`Request body schema type '${schema.type}' not supported`);
        }

        const fields = [];
        if (schema.type === "array" && schema.items) {
            const innerSchema = this.refResolver.resolve<OpenAPIV3.SchemaObject>(schema.items)
            const fieldPropertyKeys: FromSchemaNodeProperty = this.fromSchemaProperty("body", innerSchema)
            const fieldDefaults: Partial<INodeProperties> = {
                required: !!schema.required
            }
            const field = combine(fieldDefaults, fieldPropertyKeys)
            field.routing = {
                request: {
                    body: '={{ JSON.parse($value) }}'
                },
            };
            fields.push(field);
        }


        const properties = schema.properties;
        for (const key in properties) {
            const property = properties[key];
            const fieldPropertyKeys: FromSchemaNodeProperty = this.fromSchemaProperty(key, property)
            const fieldDefaults: Partial<INodeProperties> = {
                required: schema.required && schema.required?.includes(key),
            }
            const field = combine(fieldDefaults, fieldPropertyKeys)
            if (field.type === 'json') {
                field.routing = {
                    request: {
                        body: {
                            [key]: '={{ JSON.parse($value) }}',
                        },
                    },
                };
            } else {
                field.routing = {
                    request: {
                        body: {
                            [key]: '={{ $value }}',
                        },
                    },
                };
            }
            fields.push(field);
        }
        return fields;
    }

    private fromMultipartFormData(content: OpenAPIV3.MediaTypeObject): INodeProperties[] {
        const schema = this.refResolver.resolve<OpenAPIV3.SchemaObject>(content.schema!!);
        if (!schema.properties) {
            throw new Error('Multipart form data schema must have properties');
        }

        const fields: INodeProperties[] = [];
        const properties = schema.properties;

        for (const key in properties) {
            const property = properties[key];
            const resolvedProperty = this.refResolver.resolve<OpenAPIV3.SchemaObject>(property);
            
            const fieldPropertyKeys = this.fromSchemaProperty(key, resolvedProperty);
            const fieldDefaults: Partial<INodeProperties> = {
                required: schema.required?.includes(key),
            };

            const field = combine(fieldDefaults, fieldPropertyKeys);

            // Handle binary file uploads
            if (resolvedProperty.format === 'binary') {
                field.type = 'string';
                field.typeOptions = {
                    ...field.typeOptions,
                    isFilePath: true,
                };
                field.routing = {
                    request: {
                        body: {
                            [key]: '={{ $binary[$value] }}',
                        },
                    },
                };
            } else {
                // Handle regular form fields
                field.routing = {
                    request: {
                        body: {
                            [key]: '={{ $value }}',
                        },
                    },
                };
            }

            fields.push(field);
        }

        return fields;
    }
}
