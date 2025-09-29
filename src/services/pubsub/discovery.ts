/**
 * Pub/Sub Discovery Document
 *
 * Defines the Discovery Document for the Google Cloud Pub/Sub API v1,
 * including all methods, schemas, and resources for service introspection
 * and client library generation.
 */

import type { ServiceInfo } from '@/core/discovery/discovery-document-generator.js';

/**
 * Create Pub/Sub service info for Discovery API
 */
export function createPubSubServiceInfo(baseUrl: string): ServiceInfo {
  return {
    name: 'pubsub',
    version: 'v1',
    title: 'Cloud Pub/Sub API',
    description: 'Provides reliable, many-to-many, asynchronous messaging between applications.',
    baseUrl,
    servicePath: 'pubsub/v1/',
    methods: [],
    schemas: [
      // Topic schema
      {
        name: 'Topic',
        type: 'object',
        description: 'A named resource to which messages are sent by publishers.',
        properties: [
          {
            name: 'name',
            type: 'string',
            description:
              'Required. The name of the topic. It must have the format "projects/{project}/topics/{topic}".',
          },
          {
            name: 'labels',
            type: 'object',
            description:
              'See [Creating and managing labels](https://cloud.google.com/pubsub/docs/labels).',
          },
          {
            name: 'messageStoragePolicy',
            type: 'object',
            description:
              'Policy constraining the set of Google Cloud Platform regions where messages published to the topic may be stored.',
          },
          {
            name: 'kmsKeyName',
            type: 'string',
            description:
              'The resource name of the Cloud KMS CryptoKey to be used to protect access to messages published on this topic.',
          },
          {
            name: 'schemaSettings',
            type: 'object',
            description: 'Settings for validating messages published against a schema.',
          },
          {
            name: 'satisfiesPzs',
            type: 'boolean',
            description:
              'Reserved for future use. This field is set only in responses from the server.',
          },
          {
            name: 'messageRetentionDuration',
            type: 'string',
            description:
              'Indicates the minimum duration to retain a message after it is published to the topic.',
          },
        ],
        required: ['name'],
      },

      // Subscription schema
      {
        name: 'Subscription',
        type: 'object',
        description: 'A subscription resource.',
        properties: [
          {
            name: 'name',
            type: 'string',
            description:
              'Required. The name of the subscription. It must have the format "projects/{project}/subscriptions/{subscription}".',
          },
          {
            name: 'topic',
            type: 'string',
            description:
              'Required. The name of the topic from which this subscription is receiving messages.',
          },
          {
            name: 'pushConfig',
            type: 'object',
            description:
              'If push delivery is used with this subscription, this field is used to configure it.',
          },
          {
            name: 'bigqueryConfig',
            type: 'object',
            description:
              'If delivery to BigQuery is used with this subscription, this field is used to configure it.',
          },
          {
            name: 'cloudStorageConfig',
            type: 'object',
            description:
              'If delivery to Google Cloud Storage is used with this subscription, this field is used to configure it.',
          },
          {
            name: 'ackDeadlineSeconds',
            type: 'integer',
            description:
              'The approximate amount of time (on a best-effort basis) Pub/Sub waits for the subscriber to acknowledge receipt before resending the message.',
          },
          {
            name: 'retainAckedMessages',
            type: 'boolean',
            description: 'Indicates whether to retain acknowledged messages.',
          },
          {
            name: 'messageRetentionDuration',
            type: 'string',
            description:
              "How long to retain unacknowledged messages in the subscription's backlog.",
          },
          {
            name: 'labels',
            type: 'object',
            description:
              'See [Creating and managing labels](https://cloud.google.com/pubsub/docs/labels).',
          },
          {
            name: 'enableMessageOrdering',
            type: 'boolean',
            description:
              'If true, messages published with the same ordering_key in PubsubMessage will be delivered to the subscribers in the order in which they are received by the Pub/Sub system.',
          },
          {
            name: 'expirationPolicy',
            type: 'object',
            description:
              "A policy that specifies the conditions for this subscription's expiration.",
          },
          {
            name: 'filter',
            type: 'string',
            description: 'An expression written in the Pub/Sub filter language.',
          },
          {
            name: 'deadLetterPolicy',
            type: 'object',
            description:
              'A policy that specifies the conditions for dead lettering messages in this subscription.',
          },
          {
            name: 'retryPolicy',
            type: 'object',
            description:
              'A policy that specifies how Pub/Sub retries message delivery for this subscription.',
          },
          {
            name: 'detached',
            type: 'boolean',
            description: 'Indicates whether the subscription is detached from its topic.',
          },
          {
            name: 'enableExactlyOnceDelivery',
            type: 'boolean',
            description:
              'If true, Pub/Sub provides the following guarantees for the delivery of a message with a given value of messageId on this subscription.',
          },
          {
            name: 'topicMessageRetentionDuration',
            type: 'string',
            description:
              "Output only. Indicates the minimum duration for which a message is retained after it is published to the subscription's topic.",
          },
          {
            name: 'state',
            type: 'string',
            description:
              'Output only. An output-only field indicating whether or not the subscription can receive messages.',
          },
        ],
        required: ['name', 'topic'],
      },

      // PubsubMessage schema
      {
        name: 'PubsubMessage',
        type: 'object',
        description: 'A message that is published by publishers and consumed by subscribers.',
        properties: [
          {
            name: 'data',
            type: 'string',
            description:
              'The message data field. If this field is empty, the message must contain at least one attribute.',
            format: 'byte',
          },
          {
            name: 'attributes',
            type: 'object',
            description:
              'Attributes for this message. If this field is empty, the message must contain non-empty data.',
          },
          {
            name: 'messageId',
            type: 'string',
            description:
              'ID of this message, assigned by the server when the message is published.',
          },
          {
            name: 'publishTime',
            type: 'string',
            description:
              'The time at which the message was published, populated by the server when it receives the Publish call.',
            format: 'google-datetime',
          },
          {
            name: 'orderingKey',
            type: 'string',
            description:
              'If non-empty, identifies related messages for which publish order should be respected.',
          },
        ],
        required: [],
      },

      // PublishRequest schema
      {
        name: 'PublishRequest',
        type: 'object',
        description: 'Request for the Publish method.',
        properties: [
          {
            name: 'messages',
            type: 'array',
            description: 'Required. The messages to publish.',
            items: {
              name: '',
              type: 'object',
              ref: 'PubsubMessage',
            },
          },
        ],
        required: ['messages'],
      },

      // PublishResponse schema
      {
        name: 'PublishResponse',
        type: 'object',
        description: 'Response for the Publish method.',
        properties: [
          {
            name: 'messageIds',
            type: 'array',
            description:
              'The server-assigned ID of each published message, in the same order as the messages in the request.',
            items: {
              name: '',
              type: 'string',
            },
          },
        ],
        required: [],
      },

      // PullRequest schema
      {
        name: 'PullRequest',
        type: 'object',
        description: 'Request for the Pull method.',
        properties: [
          {
            name: 'maxMessages',
            type: 'integer',
            description: 'Required. The maximum number of messages to return for this request.',
          },
          {
            name: 'allowExcessMessages',
            type: 'boolean',
            description:
              'Optional. If this field set to true, the system will respond immediately even if it there are fewer messages available to return than max_messages.',
          },
          {
            name: 'returnImmediately',
            type: 'boolean',
            description:
              'Optional. If this field is set to true, the server will respond immediately even if no messages are available.',
          },
        ],
        required: ['maxMessages'],
      },

      // PullResponse schema
      {
        name: 'PullResponse',
        type: 'object',
        description: 'Response for the Pull method.',
        properties: [
          {
            name: 'receivedMessages',
            type: 'array',
            description: 'Received Pub/Sub messages.',
            items: {
              name: '',
              type: 'object',
              ref: 'ReceivedMessage',
            },
          },
        ],
        required: [],
      },

      // ReceivedMessage schema
      {
        name: 'ReceivedMessage',
        type: 'object',
        description: 'A message and its corresponding acknowledgment ID.',
        properties: [
          {
            name: 'ackId',
            type: 'string',
            description: 'This ID can be used to acknowledge the received message.',
          },
          {
            name: 'message',
            type: 'object',
            description: 'The message.',
            ref: 'PubsubMessage',
          },
          {
            name: 'deliveryAttempt',
            type: 'integer',
            description:
              'The approximate number of times that Cloud Pub/Sub has attempted to deliver the associated message to a subscriber.',
          },
        ],
        required: [],
      },

      // AcknowledgeRequest schema
      {
        name: 'AcknowledgeRequest',
        type: 'object',
        description: 'Request for the Acknowledge method.',
        properties: [
          {
            name: 'ackIds',
            type: 'array',
            description: 'Required. The acknowledgment ID for the messages being acknowledged.',
            items: {
              name: '',
              type: 'string',
            },
          },
        ],
        required: ['ackIds'],
      },

      // ModifyAckDeadlineRequest schema
      {
        name: 'ModifyAckDeadlineRequest',
        type: 'object',
        description: 'Request for the ModifyAckDeadline method.',
        properties: [
          {
            name: 'ackIds',
            type: 'array',
            description: 'Required. List of acknowledgment IDs.',
            items: {
              name: '',
              type: 'string',
            },
          },
          {
            name: 'ackDeadlineSeconds',
            type: 'integer',
            description:
              'Required. The new ack deadline with respect to the time this request was sent to the Pub/Sub system.',
          },
        ],
        required: ['ackIds', 'ackDeadlineSeconds'],
      },

      // ListTopicsRequest schema
      {
        name: 'ListTopicsRequest',
        type: 'object',
        description: 'Request for the ListTopics method.',
        properties: [
          {
            name: 'pageSize',
            type: 'integer',
            description: 'Maximum number of topics to return.',
          },
          {
            name: 'pageToken',
            type: 'string',
            description: 'The value returned by the last ListTopicsResponse.',
          },
        ],
        required: [],
      },

      // ListTopicsResponse schema
      {
        name: 'ListTopicsResponse',
        type: 'object',
        description: 'Response for the ListTopics method.',
        properties: [
          {
            name: 'topics',
            type: 'array',
            description: 'The resulting topics.',
            items: {
              name: '',
              type: 'object',
              ref: 'Topic',
            },
          },
          {
            name: 'nextPageToken',
            type: 'string',
            description: 'If not empty, indicates that there may be more topics.',
          },
        ],
        required: [],
      },

      // ListSubscriptionsRequest schema
      {
        name: 'ListSubscriptionsRequest',
        type: 'object',
        description: 'Request for the ListSubscriptions method.',
        properties: [
          {
            name: 'pageSize',
            type: 'integer',
            description: 'Maximum number of subscriptions to return.',
          },
          {
            name: 'pageToken',
            type: 'string',
            description: 'The value returned by the last ListSubscriptionsResponse.',
          },
        ],
        required: [],
      },

      // ListSubscriptionsResponse schema
      {
        name: 'ListSubscriptionsResponse',
        type: 'object',
        description: 'Response for the ListSubscriptions method.',
        properties: [
          {
            name: 'subscriptions',
            type: 'array',
            description: 'The subscriptions that match the request.',
            items: {
              name: '',
              type: 'object',
              ref: 'Subscription',
            },
          },
          {
            name: 'nextPageToken',
            type: 'string',
            description: 'If not empty, indicates that there may be more subscriptions.',
          },
        ],
        required: [],
      },

      // Empty schema (for methods that return no content)
      {
        name: 'Empty',
        type: 'object',
        description:
          'A generic empty message that you can re-use to avoid defining duplicated empty messages in your APIs.',
        properties: [],
        required: [],
      },
    ],
    resources: [
      // Projects resource
      {
        name: 'projects',
        methods: [],
        resources: [
          // Topics resource under projects
          {
            name: 'topics',
            methods: [
              {
                name: 'create',
                httpMethod: 'PUT',
                path: 'projects/{project}/topics/{topic}',
                description: 'Creates the given topic with the given name.',
                parameters: [
                  {
                    name: 'name',
                    type: 'string',
                    location: 'path',
                    required: true,
                    description:
                      'Required. The name of the topic. It must have the format "projects/{project}/topics/{topic}".',
                  },
                ],
                requestSchema: 'Topic',
                responseSchema: 'Topic',
                scopes: [
                  'https://www.googleapis.com/auth/cloud-platform',
                  'https://www.googleapis.com/auth/pubsub',
                ],
              },
              {
                name: 'get',
                httpMethod: 'GET',
                path: 'projects/{project}/topics/{topic}',
                description: 'Gets the configuration of a topic.',
                parameters: [
                  {
                    name: 'topic',
                    type: 'string',
                    location: 'path',
                    required: true,
                    description: 'Required. The name of the topic to get.',
                  },
                ],
                responseSchema: 'Topic',
                scopes: [
                  'https://www.googleapis.com/auth/cloud-platform',
                  'https://www.googleapis.com/auth/pubsub',
                ],
              },
              {
                name: 'list',
                httpMethod: 'GET',
                path: 'projects/{project}/topics',
                description: 'Lists matching topics.',
                parameters: [
                  {
                    name: 'project',
                    type: 'string',
                    location: 'path',
                    required: true,
                    description: 'Required. The name of the project in which to list topics.',
                  },
                  {
                    name: 'pageSize',
                    type: 'integer',
                    location: 'query',
                    required: false,
                    description: 'Maximum number of topics to return.',
                  },
                  {
                    name: 'pageToken',
                    type: 'string',
                    location: 'query',
                    required: false,
                    description: 'The value returned by the last ListTopicsResponse.',
                  },
                ],
                responseSchema: 'ListTopicsResponse',
                scopes: [
                  'https://www.googleapis.com/auth/cloud-platform',
                  'https://www.googleapis.com/auth/pubsub',
                ],
              },
              {
                name: 'patch',
                httpMethod: 'PATCH',
                path: 'projects/{project}/topics/{topic}',
                description: 'Updates an existing topic.',
                parameters: [
                  {
                    name: 'name',
                    type: 'string',
                    location: 'path',
                    required: true,
                    description: 'Required. The name of the topic.',
                  },
                ],
                requestSchema: 'Topic',
                responseSchema: 'Topic',
                scopes: [
                  'https://www.googleapis.com/auth/cloud-platform',
                  'https://www.googleapis.com/auth/pubsub',
                ],
              },
              {
                name: 'delete',
                httpMethod: 'DELETE',
                path: 'projects/{project}/topics/{topic}',
                description: 'Deletes the topic with the given name.',
                parameters: [
                  {
                    name: 'topic',
                    type: 'string',
                    location: 'path',
                    required: true,
                    description: 'Required. Name of the topic to delete.',
                  },
                ],
                responseSchema: 'Empty',
                scopes: [
                  'https://www.googleapis.com/auth/cloud-platform',
                  'https://www.googleapis.com/auth/pubsub',
                ],
              },
              {
                name: 'publish',
                httpMethod: 'POST',
                path: 'projects/{project}/topics/{topic}:publish',
                description: 'Adds one or more messages to the topic.',
                parameters: [
                  {
                    name: 'topic',
                    type: 'string',
                    location: 'path',
                    required: true,
                    description:
                      'Required. The messages in the request will be published on this topic.',
                  },
                ],
                requestSchema: 'PublishRequest',
                responseSchema: 'PublishResponse',
                scopes: [
                  'https://www.googleapis.com/auth/cloud-platform',
                  'https://www.googleapis.com/auth/pubsub',
                ],
              },
            ],
            resources: [],
          },

          // Subscriptions resource under projects
          {
            name: 'subscriptions',
            methods: [
              {
                name: 'create',
                httpMethod: 'PUT',
                path: 'projects/{project}/subscriptions/{subscription}',
                description: 'Creates a subscription to a given topic.',
                parameters: [
                  {
                    name: 'name',
                    type: 'string',
                    location: 'path',
                    required: true,
                    description: 'Required. The name of the subscription.',
                  },
                ],
                requestSchema: 'Subscription',
                responseSchema: 'Subscription',
                scopes: [
                  'https://www.googleapis.com/auth/cloud-platform',
                  'https://www.googleapis.com/auth/pubsub',
                ],
              },
              {
                name: 'get',
                httpMethod: 'GET',
                path: 'projects/{project}/subscriptions/{subscription}',
                description: 'Gets the configuration details of a subscription.',
                parameters: [
                  {
                    name: 'subscription',
                    type: 'string',
                    location: 'path',
                    required: true,
                    description: 'Required. The name of the subscription to get.',
                  },
                ],
                responseSchema: 'Subscription',
                scopes: [
                  'https://www.googleapis.com/auth/cloud-platform',
                  'https://www.googleapis.com/auth/pubsub',
                ],
              },
              {
                name: 'list',
                httpMethod: 'GET',
                path: 'projects/{project}/subscriptions',
                description: 'Lists matching subscriptions.',
                parameters: [
                  {
                    name: 'project',
                    type: 'string',
                    location: 'path',
                    required: true,
                    description:
                      'Required. The name of the project in which to list subscriptions.',
                  },
                  {
                    name: 'pageSize',
                    type: 'integer',
                    location: 'query',
                    required: false,
                    description: 'Maximum number of subscriptions to return.',
                  },
                  {
                    name: 'pageToken',
                    type: 'string',
                    location: 'query',
                    required: false,
                    description: 'The value returned by the last ListSubscriptionsResponse.',
                  },
                ],
                responseSchema: 'ListSubscriptionsResponse',
                scopes: [
                  'https://www.googleapis.com/auth/cloud-platform',
                  'https://www.googleapis.com/auth/pubsub',
                ],
              },
              {
                name: 'patch',
                httpMethod: 'PATCH',
                path: 'projects/{project}/subscriptions/{subscription}',
                description: 'Updates an existing subscription.',
                parameters: [
                  {
                    name: 'name',
                    type: 'string',
                    location: 'path',
                    required: true,
                    description: 'Required. The name of the subscription.',
                  },
                ],
                requestSchema: 'Subscription',
                responseSchema: 'Subscription',
                scopes: [
                  'https://www.googleapis.com/auth/cloud-platform',
                  'https://www.googleapis.com/auth/pubsub',
                ],
              },
              {
                name: 'delete',
                httpMethod: 'DELETE',
                path: 'projects/{project}/subscriptions/{subscription}',
                description: 'Deletes an existing subscription.',
                parameters: [
                  {
                    name: 'subscription',
                    type: 'string',
                    location: 'path',
                    required: true,
                    description: 'Required. The subscription to delete.',
                  },
                ],
                responseSchema: 'Empty',
                scopes: [
                  'https://www.googleapis.com/auth/cloud-platform',
                  'https://www.googleapis.com/auth/pubsub',
                ],
              },
              {
                name: 'pull',
                httpMethod: 'POST',
                path: 'projects/{project}/subscriptions/{subscription}:pull',
                description: 'Pulls messages from the subscription.',
                parameters: [
                  {
                    name: 'subscription',
                    type: 'string',
                    location: 'path',
                    required: true,
                    description: 'Required. The subscription from which messages should be pulled.',
                  },
                ],
                requestSchema: 'PullRequest',
                responseSchema: 'PullResponse',
                scopes: [
                  'https://www.googleapis.com/auth/cloud-platform',
                  'https://www.googleapis.com/auth/pubsub',
                ],
              },
              {
                name: 'acknowledge',
                httpMethod: 'POST',
                path: 'projects/{project}/subscriptions/{subscription}:acknowledge',
                description: 'Acknowledges the messages associated with the ack_ids.',
                parameters: [
                  {
                    name: 'subscription',
                    type: 'string',
                    location: 'path',
                    required: true,
                    description: 'Required. The subscription whose message is being acknowledged.',
                  },
                ],
                requestSchema: 'AcknowledgeRequest',
                responseSchema: 'Empty',
                scopes: [
                  'https://www.googleapis.com/auth/cloud-platform',
                  'https://www.googleapis.com/auth/pubsub',
                ],
              },
              {
                name: 'modifyAckDeadline',
                httpMethod: 'POST',
                path: 'projects/{project}/subscriptions/{subscription}:modifyAckDeadline',
                description: 'Modifies the ack deadline for a specific message.',
                parameters: [
                  {
                    name: 'subscription',
                    type: 'string',
                    location: 'path',
                    required: true,
                    description: 'Required. The name of the subscription.',
                  },
                ],
                requestSchema: 'ModifyAckDeadlineRequest',
                responseSchema: 'Empty',
                scopes: [
                  'https://www.googleapis.com/auth/cloud-platform',
                  'https://www.googleapis.com/auth/pubsub',
                ],
              },
            ],
            resources: [],
          },
        ],
      },
    ],
  };
}
