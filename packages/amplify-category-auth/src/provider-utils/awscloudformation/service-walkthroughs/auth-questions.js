const inquirer = require('inquirer');
const chalk = require('chalk');
const _ = require('lodash');
const { uniq, pullAll } = require('lodash');
const path = require('path');
const { Sort } = require('enquirer');
// const { parseTriggerSelections } = require('../utils/trigger-flow-auth-helper');
const { extractApplePrivateKey } = require('../utils/extract-apple-private-key');
const { authProviders, attributeProviderMap, capabilities } = require('../assets/string-maps');

const category = 'auth';

async function serviceWalkthrough(context, defaultValuesFilename, stringMapsFilename, serviceMetadata, coreAnswers = {}) {
  const { inputs } = serviceMetadata;
  const { amplify } = context;
  const { parseInputs } = require(`${__dirname}/../question-factories/core-questions.js`);
  const projectType = amplify.getProjectConfig().frontend;
  const defaultValuesSrc = `${__dirname}/../assets/${defaultValuesFilename}`;
  const { getAllDefaults } = require(defaultValuesSrc);
  let userPoolGroupList = context.amplify.getUserPoolGroupList(context);
  let adminQueryGroup;

  // LOAD POTENTIAL PREVIOUS RESPONSES
  handleUpdates(context, coreAnswers);

  // QUESTION LOOP
  let j = 0;
  while (j < inputs.length) {
    const questionObj = inputs[j];

    // CREATE QUESTION OBJECT
    const q = await parseInputs(questionObj, amplify, defaultValuesFilename, stringMapsFilename, coreAnswers, context);

    // ASK QUESTION
    const answer = await inquirer.prompt(q);

    if ('signinwithapplePrivateKeyUserPool' in answer) {
      answer.signinwithapplePrivateKeyUserPool = extractApplePrivateKey(answer.signinwithapplePrivateKeyUserPool);
    }
    if (answer.userPoolGroups === true) {
      userPoolGroupList = await updateUserPoolGroups(context);
    }

    if (answer.adminQueries === true) {
      adminQueryGroup = await updateAdminQuery(context, userPoolGroupList);
    }

    if (answer.triggers && answer.triggers !== '{}') {
      const tempTriggers = context.updatingAuth && context.updatingAuth.triggers ? JSON.parse(context.updatingAuth.triggers) : {};
      const selectionMetadata = capabilities;

      /* eslint-disable no-loop-func */
      selectionMetadata.forEach(s => {
        Object.keys(s.triggers).forEach(t => {
          if (!tempTriggers[t] && answer.triggers.includes(s.value)) {
            tempTriggers[t] = s.triggers[t];
          } else if (tempTriggers[t] && answer.triggers.includes(s.value)) {
            tempTriggers[t] = uniq(tempTriggers[t].concat(s.triggers[t]));
          } else if (tempTriggers[t] && !answer.triggers.includes(s.value)) {
            const tempForDiff = Object.assign([], tempTriggers[t]);
            const remainder = pullAll(tempForDiff, s.triggers[t]);
            if (remainder && remainder.length > 0) {
              tempTriggers[t] = remainder;
            } else {
              delete tempTriggers[t];
            }
          }
        });
      });
      answer.triggers = tempTriggers;
    }

    // LEARN MORE BLOCK
    if (new RegExp(/learn/i).test(answer[questionObj.key]) && questionObj.learnMore) {
      const helpText = `\n${questionObj.learnMore.replace(new RegExp('[\\n]', 'g'), '\n\n')}\n\n`;
      questionObj.prefix = chalk.green(helpText);
      // ITERATOR BLOCK
    } else if (
      /*
        if the input has an 'iterator' value, we generate a loop which uses the iterator value as a
        key to find the array of values it should splice into.
      */
      questionObj.iterator &&
      answer[questionObj.key] &&
      answer[questionObj.key].length > 0
    ) {
      if (questionObj.iterator.endsWith('oidcAttributesMapping')) {
        // Get data from existing entries loaded from stack parameters.json
        let map = context.updatingAuth && context.updatingAuth['oidcAttributesMapping'] ? JSON.parse(context.updatingAuth['oidcAttributesMapping']) : {};
        for (let t = 0; t < answer[questionObj.key].length; t += 1) {
          let currentValue = map[answer[questionObj.key][t]] ? `(current value: ${map[answer[questionObj.key][t]]})`: '';
          if (questionObj.key === 'RemoveMappings') {
            delete map[answer[questionObj.key][t]]
          } else {
            const response = await inquirer.prompt({
              name: 'oidcProviderAttributeName',
              message: `Which OIDC provider’s attribute should map to Cognito’s "${chalk.green(answer[questionObj.key][t])}" attribute? ${currentValue}`,
            });
            map[answer[questionObj.key][t]] = response.oidcProviderAttributeName;
          }
        }
        // Override current data to take changes into account
        coreAnswers.oidcAttributesMapping = {};
        Object.assign(coreAnswers.oidcAttributesMapping, map);
        if (context.updatingAuth) {
          context.updatingAuth['oidcAttributesMapping'] = JSON.stringify(map);
        }
      }
      else {
        const replacementArray = context.updatingAuth[questionObj.iterator];

        for (let t = 0; t < answer[questionObj.key].length; t += 1) {
          questionObj.validation = questionObj.iteratorValidation;
          if (questionObj.key === 'RemoveScopes') {
            replacementArray.splice(replacementArray.indexOf(answer[questionObj.key][t]), 1);
          } else {
            const newValue = await inquirer.prompt({
              name: 'updated',
              message: `Update ${answer[questionObj.key][t]}`,
              validate: amplify.inputValidation(questionObj),
            });
            replacementArray.splice(replacementArray.indexOf(answer[questionObj.key][t]), 1, newValue.updated);
          }
        }
      }
      j += 1;
      // ADD-ANOTHER BLOCK
    } else if (questionObj.addAnotherLoop && Object.keys(answer).length > 0) {
      /*
        if the input has an 'addAnotherLoop' value, we first make sure that the answer
        will be recorded as an array index, and if it is already an array we push the new value.
        We then ask the user if they want to add another url.  If not, we increment our counter (j)
        so that the next question is appears in the prompt.  If the counter isn't incremented,
        the same question is reapated.
      */
      if (!coreAnswers[questionObj.key]) {
        answer[questionObj.key] = [answer[questionObj.key]];
        coreAnswers = { ...coreAnswers, ...answer };
      } else {
        coreAnswers[questionObj.key].push(answer[questionObj.key]);
      }
      const addAnother = await inquirer.prompt({
        name: 'repeater',
        type: 'confirm',
        default: false,
        message: `Do you want to add another ${questionObj.addAnotherLoop}`,
      });
      if (!addAnother.repeater) {
        j += 1;
      }
    } else if (questionObj.key === 'updateFlow') {
      /*
        if the user selects a default or fully manual config option during an update,
        we set the useDefault value so that the appropriate questions are displayed
      */
      if (answer.updateFlow === 'updateUserPoolGroups') {
        userPoolGroupList = await updateUserPoolGroups(context);
      } else if (answer.updateFlow === 'updateAdminQueries') {
        adminQueryGroup = await updateAdminQuery(context, userPoolGroupList);
      } else if (['manual', 'defaultSocial', 'default'].includes(answer.updateFlow)) {
        answer.useDefault = answer.updateFlow;
        if (answer.useDefault === 'defaultSocial') {
          coreAnswers.hostedUI = true;
        }

        if (answer.useDefault === 'default') {
          coreAnswers.hostedUI = false;
        }
        delete answer.updateFlow;
      }
      coreAnswers = { ...coreAnswers, ...answer };
      j += 1;
    } else if (!context.updatingAuth && answer.useDefault && ['default', 'defaultSocial'].includes(answer.useDefault)) {
      // if the user selects defaultSocial, we set hostedUI to true to avoid reasking this question
      coreAnswers = { ...coreAnswers, ...answer };
      coreAnswers.authSelections = 'identityPoolAndUserPool';
      if (coreAnswers.useDefault === 'defaultSocial') {
        coreAnswers.hostedUI = true;
      }
      j += 1;
    } else {
      coreAnswers = { ...coreAnswers, ...answer };
      j += 1;
    }
  }

  // POST-QUESTION LOOP PARSING

  // if user selects user pool only, ensure that we clean id pool options
  if (coreAnswers.authSelections === 'userPoolOnly' && context.updatingAuth) {
    context.print.warning(
      `Warning! Your existing IdentityPool: ${context.updatingAuth.identityPoolName} will be deleted upon the next “amplify push”!`,
    );
    delete context.updatingAuth.identityPoolName;
    delete context.updatingAuth.allowUnauthenticatedIdentities;
    delete context.updatingAuth.thirdPartyAuth;
    delete context.updatingAuth.authProviders;
    delete context.updatingAuth.facebookAppId;
    delete context.updatingAuth.oidcAppId;
    delete context.updatingAuth.googleClientId;
    delete context.updatingAuth.googleIos;
    delete context.updatingAuth.googleAndroid;
    delete context.updatingAuth.amazonAppId;
    delete context.updatingAuth.appleAppId;
  }

  // formatting data for identity pool providers
  if (coreAnswers.thirdPartyAuth) {
    identityPoolProviders(coreAnswers, projectType);
  }

  const isPullOrEnvCommand = context.input.command === 'pull' || context.input.command === 'env';
  if (coreAnswers.authSelections !== 'identityPoolOnly' && context.input.command != 'init' && !isPullOrEnvCommand) {
    if (coreAnswers.useDefault === 'manual') {
      coreAnswers.triggers = await lambdaFlow(context, coreAnswers.triggers);
    }
  }

  // formatting data for user pool providers / hosted UI
  if (coreAnswers.authProvidersUserPool) {
    /* eslint-disable */
    coreAnswers = Object.assign(coreAnswers, userPoolProviders(coreAnswers.authProvidersUserPool, coreAnswers, context.updatingAuth));
    /* eslint-enable */
  }

  // formatting oAuthMetaData
  structureOAuthMetadata(coreAnswers, context, getAllDefaults, amplify);

  if (coreAnswers.usernameAttributes && !Array.isArray(coreAnswers.usernameAttributes)) {
    if (coreAnswers.usernameAttributes === 'username') {
      delete coreAnswers.usernameAttributes;
    } else {
      coreAnswers.usernameAttributes = coreAnswers.usernameAttributes.split();
    }
  }

  return {
    ...coreAnswers,
    userPoolGroupList,
    adminQueryGroup,
    serviceName: 'Cognito',
  };
}

async function updateUserPoolGroups(context) {
  let userPoolGroupList = [];
  let existingGroups;

  const userGroupParamsPath = path.join(
    context.amplify.pathManager.getBackendDirPath(),
    'auth',
    'userPoolGroups',
    'user-pool-group-precedence.json',
  );

  try {
    existingGroups = context.amplify.readJsonFile(userGroupParamsPath);
    userPoolGroupList = existingGroups.map(e => e.groupName);
  } catch (e) {
    existingGroups = null;
  }

  if (existingGroups) {
    // eslint-disable-next-line
    const deletionChoices = existingGroups.map(e => {
      return { name: e.groupName, value: e.groupName };
    });

    const deletionAnswer = await inquirer.prompt([
      {
        name: 'groups2BeDeleted',
        type: 'checkbox',
        message: 'Select any user pool groups you want to delete:',
        choices: deletionChoices,
      },
    ]);

    userPoolGroupList = userPoolGroupList.filter(i => !deletionAnswer.groups2BeDeleted.includes(i));
  }

  let answer;

  /* Must be sure to ask this question in the event that it is the
  first time in the user pool group flow, or it is an update but
  the user has deleted all existing groups. If they want to delete
  all groups they should just delete the resource */
  if (userPoolGroupList.length < 1) {
    answer = await inquirer.prompt([
      {
        name: 'userPoolGroupName',
        type: 'input',
        message: 'Provide a name for your user pool group:',
        validate: context.amplify.inputValidation({
          validation: {
            operator: 'regex',
            value: '^[a-zA-Z0-9]+$',
            onErrorMsg: 'Resource name should be alphanumeric',
          },
          required: true,
        }),
      },
    ]);
    userPoolGroupList.push(answer.userPoolGroupName);
  }

  let addAnother = await inquirer.prompt({
    name: 'repeater',
    type: 'confirm',
    default: false,
    message: 'Do you want to add another User Pool Group',
  });

  while (addAnother.repeater === true) {
    answer = await inquirer.prompt([
      {
        name: 'userPoolGroupName',
        type: 'input',
        message: 'Provide a name for your user pool group:',
        validate: context.amplify.inputValidation({
          validation: {
            operator: 'regex',
            value: '^[a-zA-Z0-9]+$',
            onErrorMsg: 'Resource name should be alphanumeric',
          },
          required: true,
        }),
      },
    ]);

    userPoolGroupList.push(answer.userPoolGroupName);

    addAnother = await inquirer.prompt({
      name: 'repeater',
      type: 'confirm',
      default: false,
      message: 'Do you want to add another User Pool Group',
    });
  }

  // Get distinct list
  const distinctSet = new Set(userPoolGroupList);
  userPoolGroupList = Array.from(distinctSet);

  // Sort the Array to get precedence
  let sortedUserPoolGroupList = [];

  if (userPoolGroupList && userPoolGroupList.length > 0) {
    const sortPrompt = new Sort({
      name: 'sortUserPools',
      hint: `(Use ${chalk.green.bold('<shift>+<right/left>')} to change the order)`,
      message: 'Sort the user pool groups in order of preference',
      choices: userPoolGroupList,
      shiftLeft(...args) {
        return this.shiftUp(...args);
      },
      shiftRight(...args) {
        return this.shiftDown(...args);
      },
    });

    sortedUserPoolGroupList = await sortPrompt.run();
  }
  return sortedUserPoolGroupList;
}

async function updateAdminQuery(context, userPoolGroupList) {
  let adminGroup;
  // Clone user pool group list
  const userPoolGroupListClone = userPoolGroupList.slice(0);
  if (await context.amplify.confirmPrompt('Do you want to restrict access to the admin queries API to a specific Group')) {
    userPoolGroupListClone.push('Enter a custom group');

    const adminGroupAnswer = await inquirer.prompt([
      {
        name: 'adminGroup',
        type: 'list',
        message: 'Select the group to restrict access with:',
        choices: userPoolGroupListClone,
      },
    ]);

    if (adminGroupAnswer.adminGroup === 'Enter a custom group') {
      const temp = await inquirer.prompt([
        {
          name: 'userPoolGroupName',
          type: 'input',
          message: 'Provide a group name:',
          validate: context.amplify.inputValidation({
            validation: {
              operator: 'regex',
              value: '^[a-zA-Z0-9]+$',
              onErrorMsg: 'Resource name should be alphanumeric',
            },
            required: true,
          }),
        },
      ]);
      adminGroup = temp.userPoolGroupName;
    } else {
      ({ adminGroup } = adminGroupAnswer);
    }
  }
  return adminGroup;
}

/*
  Create key/value pairs of third party auth providers,
  where key = name accepted by updateIdentityPool API call and value = id entered by user
*/
function identityPoolProviders(coreAnswers, projectType) {
  coreAnswers.selectedParties = {};
  authProviders.forEach(e => {
    // don't send google value in cf if native project, since we need to make an openid provider
    if (projectType === 'javascript' || e.answerHashKey !== 'googleClientId') {
      if (coreAnswers[e.answerHashKey]) {
        coreAnswers.selectedParties[e.value] = coreAnswers[e.answerHashKey];
      }
      /*
        certain third party providers require multiple values,
        which Cognito requires to be a concatenated string -
        so here we build the string using 'concatKeys' defined in the thirdPartyMap
      */
      if (coreAnswers[e.answerHashKey] && e.concatKeys) {
        e.concatKeys.forEach(i => {
          coreAnswers.selectedParties[e.value] = coreAnswers.selectedParties[e.value].concat(';', coreAnswers[i]);
        });
      }
    }
  });
  if (projectType !== 'javascript' && coreAnswers.authProviders.includes('accounts.google.com')) {
    coreAnswers.audiences = [coreAnswers.googleClientId];
    if (projectType === 'ios') {
      coreAnswers.audiences.push(coreAnswers.googleIos);
    } else if (projectType === 'android') {
      coreAnswers.audiences.push(coreAnswers.googleAndroid);
    }
  }
  coreAnswers.selectedParties = JSON.stringify(coreAnswers.selectedParties);
}

/*
  Format hosted UI providers data per lambda spec
  hostedUIProviderMeta is saved in parameters.json.
  hostedUIproviderCreds is saved in deployment-secrets.
*/
function userPoolProviders(oAuthProviders, coreAnswers, prevAnswers) {
  if (coreAnswers.useDefault === 'default') {
    return null;
  }
  const answers = Object.assign(prevAnswers || {}, coreAnswers);
  const attributesForMapping = answers.requiredAttributes
    ? JSON.parse(JSON.stringify(answers.requiredAttributes)).concat('username')
    : ['email', 'username'];
  const res = {};
  if (answers.hostedUI) {
    res.hostedUIProviderMeta = JSON.stringify(
      oAuthProviders.map(el => {
        const lowerCaseEl = el.toLowerCase();
        const delimiter = el === 'Facebook' || el === 'SignInWithApple' ? ',' : ' ';
        const scopes = [];
        const maps = {};
        let oidc_issuer = undefined;
        let attributes_request_method = undefined;
        if (el === 'OIDC') {
          oidc_issuer = answers.oidcAppOIDCIssuer;
          attributes_request_method = answers.oidcAppOIDCAttributesRequestMethod;

          if (answers.oidcAuthorizeScopes) {
            // from update auth with additional scope added
            answers.oidcAuthorizeScopes.forEach(
              // this is an array but contains element(s) that are comma delimited
              scope => scopes.push(...scope.split(','))
            )
          }

          if (coreAnswers.newOIDCAuthorizeScopes) {
            // from add auth
            coreAnswers.newOIDCAuthorizeScopes.forEach(
              // this is an array but contains element(s) that are comma delimited
              scope => scopes.push(...scope.split(','))
            )
          }

          switch (typeof answers.oidcAttributesMapping) {
            case 'string':
              // from update auth => previous data loaded from file as escaped string
              Object.assign(maps, JSON.parse(answers.oidcAttributesMapping));
              break;
            case 'object':
              // from add auth
              Object.assign(maps, answers.oidcAttributesMapping);
              break;
          }
        } else {
          attributesForMapping.forEach(a => {
            const attributeKey = attributeProviderMap[a];
            if (attributeKey && attributeKey[`${lowerCaseEl}`] && attributeKey[`${lowerCaseEl}`].scope) {
              if (scopes.indexOf(attributeKey[`${lowerCaseEl}`].scope) === -1) {
                scopes.push(attributeKey[`${lowerCaseEl}`].scope);
              }
            }
            if (attributeKey && attributeKey[`${lowerCaseEl}`] && attributeKey[`${lowerCaseEl}`].attr) {
              maps[a] = attributeKey[`${lowerCaseEl}`].attr;
            }
          });
        }

        // remove duplicates - OpenID scopes are case sensitive so we do not alter or remove case insensitive duplicates
        const authorized_scopes = [...new Set(scopes)];
        const requires_scope_openid = [
          'Google',
          'OIDC',
        ];
        if (requires_scope_openid.includes(el) && !authorized_scopes.includes('openid')) {
          // Add required openid scope if missing
          // https://openid.net/specs/openid-connect-core-1_0.html#AuthRequest
          // OpenID Connect uses the following OAuth 2.0 request parameters with the Authorization Code Flow:
          // scope
          //   REQUIRED. OpenID Connect requests MUST contain the openid scope value. If the openid scope value is not present, the behavior is entirely unspecified.
          authorized_scopes.unshift('openid');
        }

        return {
          ProviderName: el,
          authorize_scopes: authorized_scopes.join(delimiter),
          oidc_issuer:  oidc_issuer,
          attributes_request_method: attributes_request_method,
          AttributeMapping: maps,
        };
      }),
    );
    res.hostedUIProviderCreds = JSON.stringify(
      oAuthProviders.map(el => {
        const lowerCaseEl = el.toLowerCase();
        if (el === 'SignInWithApple') {
          return {
            ProviderName: el,
            client_id: coreAnswers[`${lowerCaseEl}ClientIdUserPool`],
            team_id: coreAnswers[`${lowerCaseEl}TeamIdUserPool`],
            key_id: coreAnswers[`${lowerCaseEl}KeyIdUserPool`],
            private_key: coreAnswers[`${lowerCaseEl}PrivateKeyUserPool`],
          };
        } else {
          return {
            ProviderName: el,
            client_id: coreAnswers[`${lowerCaseEl}AppIdUserPool`],
            client_secret: coreAnswers[`${lowerCaseEl}AppSecretUserPool`],
          };
        }
      }),
    );
  }
  return res;
}

/*
  Format hosted UI oAuth data per lambda spec
*/
function structureOAuthMetadata(coreAnswers, context, defaults, amplify) {
  if (coreAnswers.useDefault === 'default' && context.updatingAuth) {
    delete context.updatingAuth.oAuthMetadata;
    return null;
  }
  const answers = Object.assign({}, context.updatingAuth, coreAnswers);
  let { AllowedOAuthFlows, AllowedOAuthScopes, CallbackURLs, LogoutURLs } = answers;
  if (CallbackURLs && coreAnswers.newCallbackURLs) {
    CallbackURLs = CallbackURLs.concat(coreAnswers.newCallbackURLs);
  } else if (coreAnswers.newCallbackURLs) {
    CallbackURLs = coreAnswers.newCallbackURLs;
  }
  if (LogoutURLs && coreAnswers.newLogoutURLs) {
    LogoutURLs = LogoutURLs.concat(coreAnswers.newLogoutURLs);
  } else if (coreAnswers.newLogoutURLs) {
    LogoutURLs = coreAnswers.newLogoutURLs;
  }

  if (CallbackURLs && LogoutURLs) {
    if (!answers.AllowedOAuthScopes) {
      /* eslint-disable */
      AllowedOAuthScopes = defaults(amplify.getProjectDetails(amplify)).AllowedOAuthScopes;
    }
    if (!answers.AllowedOAuthFlows) {
      AllowedOAuthFlows = defaults(amplify.getProjectDetails(amplify)).AllowedOAuthFlows;
      /* eslint-enable */
    } else {
      AllowedOAuthFlows = Array.isArray(AllowedOAuthFlows) ? AllowedOAuthFlows : [AllowedOAuthFlows];
    }
  }

  if (AllowedOAuthFlows && AllowedOAuthScopes && CallbackURLs && LogoutURLs) {
    coreAnswers.oAuthMetadata = JSON.stringify({
      AllowedOAuthFlows,
      AllowedOAuthScopes,
      CallbackURLs,
      LogoutURLs,
    });
  }

  return coreAnswers;
}

/*
  Deserialize oAuthData for CLI update flow
*/
function parseOAuthMetaData(previousAnswers) {
  if (previousAnswers && previousAnswers.oAuthMetadata) {
    previousAnswers = Object.assign(previousAnswers, JSON.parse(previousAnswers.oAuthMetadata));
    delete previousAnswers.oAuthMetadata;
  }
}

/*
  Deserialize oAuthCredentials for CLI update flow
*/
function parseOAuthCreds(providers, metadata, envCreds) {
  const providerKeys = {};
  try {
    const parsedMetaData = JSON.parse(metadata);
    const parsedCreds = JSON.parse(envCreds);
    providers.forEach(el => {
      const lowerCaseEl = el.toLowerCase();
      try {
        const provider = parsedMetaData.find(i => i.ProviderName === el);
        const creds = parsedCreds.find(i => i.ProviderName === el);
        if (el === 'SignInWithApple') {
          providerKeys[`${lowerCaseEl}ClientIdUserPool`] = creds.client_id;
          providerKeys[`${lowerCaseEl}TeamIdUserPool`] = creds.team_id;
          providerKeys[`${lowerCaseEl}KeyIdUserPool`] = creds.key_id;
          providerKeys[`${lowerCaseEl}PrivateKeyUserPool`] = creds.private_key;
        } else {
          if (el === 'OIDC') {
            providerKeys[`${lowerCaseEl}AppOIDCIssuer`] = provider.oidc_issuer;
            // split on ' ' for authorized scopes seem more intuitive based on OIDC but below it is splitting on ','
            providerKeys[`${lowerCaseEl}AuthorizeScopes`] = provider.authorize_scopes.split(' ').filter(scope => scope != 'openid');
            if (providerKeys[`${lowerCaseEl}AuthorizeScopes`].length === 0) {
              providerKeys[`${lowerCaseEl}AuthorizeScopes`] = undefined;
            }
            providerKeys[`${lowerCaseEl}AttributesMapping`] = JSON.stringify(provider.AttributeMapping);
          }
          providerKeys[`${lowerCaseEl}AppIdUserPool`] = creds.client_id;
          providerKeys[`${lowerCaseEl}AppSecretUserPool`] = creds.client_secret;
        }
        if (providerKeys[`${lowerCaseEl}AuthorizeScopes`].length === 0) {
          /*
           * hacky to not overwrite OIDC AuthorizeScopes that is splitting on space.
           * This looks like an edge case bug to split on ',' as an OIDC scope can not contain a space but may contain a ','
           * ---
           * https://www.rfc-editor.org/rfc/rfc6749.html#appendix-A.4
           * A.4.  "scope" Syntax
           *    The "scope" element is defined in Section 3.3:
           *      scope       = scope-token *( SP scope-token )
           *      scope-token = 1*NQCHAR
           * https://www.rfc-editor.org/rfc/rfc6749.html#appendix-A
           * Appendix A.  Augmented Backus-Naur Form (ABNF) Syntax
           *
           *    This section provides Augmented Backus-Naur Form (ABNF) syntax
           *    descriptions for the elements defined in this specification using the
           *    notation of [RFC5234].  The ABNF below is defined in terms of Unicode
           *    code points [W3C.REC-xml-20081126]; these characters are typically
           *    encoded in UTF-8.  Elements are presented in the order first defined.
           *
           *    Some of the definitions that follow use the "URI-reference"
           *    definition from [RFC3986].
           *
           *    Some of the definitions that follow use these common definitions:
           *
           *      VSCHAR     = %x20-7E
           *      NQCHAR     = %x21 / %x23-5B / %x5D-7E
           *      NQSCHAR    = %x20-21 / %x23-5B / %x5D-7E
           *      UNICODECHARNOCRLF = %x09 /%x20-7E / %x80-D7FF /
           *                          %xE000-FFFD / %x10000-10FFFF
           *
           *    (The UNICODECHARNOCRLF definition is based upon the Char definition
           *    in Section 2.2 of [W3C.REC-xml-20081126], but omitting the Carriage
           *    Return and Linefeed characters.)
           */
          providerKeys[`${lowerCaseEl}AuthorizeScopes`] = provider.authorize_scopes.split(',');
        }
      } catch (e) {
        return null;
      }
    });
  } catch (e) {
    return {};
  }
  return providerKeys;
}

/*
  Handle updates: loading existing responses from parameters.json and team provider info into context.updatingAuth
*/
function handleUpdates(context, coreAnswers) {
  if (context.updatingAuth && context.updatingAuth.triggers) {
    coreAnswers.triggers = {};
    coreAnswers.triggers = context.updatingAuth.triggers;
  }

  if (context.updatingAuth && context.updatingAuth.oAuthMetadata) {
    parseOAuthMetaData(context.updatingAuth);
  }

  if (context.updatingAuth && context.updatingAuth.authProvidersUserPool) {
    const { resourceName, authProvidersUserPool, hostedUIProviderMeta } = context.updatingAuth;
    const { hostedUIProviderCreds } = context.amplify.loadEnvResourceParameters(context, 'auth', resourceName);
    /* eslint-disable */
    const oAuthCreds = parseOAuthCreds(authProvidersUserPool, hostedUIProviderMeta, hostedUIProviderCreds);
    /* eslint-enable */

    context.updatingAuth = Object.assign(context.updatingAuth, oAuthCreds);
  }

  if (context.updatingAuth && context.updatingAuth.authSelections === 'identityPoolOnly') {
    coreAnswers.authSelections = 'identityPoolAndUserPool';
  }
}

/*
  Adding lambda triggers
*/
async function lambdaFlow(context, answers) {
  const triggers = await context.amplify.triggerFlow(context, 'cognito', 'auth', answers);
  return triggers || answers;
}

function getIAMPolicies(context, resourceName, crudOptions) {
  let policy = {};
  const actions = [];

  crudOptions.forEach(crudOption => {
    switch (crudOption) {
      case 'create':
        actions.push(
          'cognito-idp:ConfirmSignUp',
          'cognito-idp:AdminCreateUser',
          'cognito-idp:CreateUserImportJob',
          'cognito-idp:AdminSetUserSettings',
          'cognito-idp:AdminLinkProviderForUser',
          'cognito-idp:CreateIdentityProvider',
          'cognito-idp:AdminConfirmSignUp',
          'cognito-idp:AdminDisableUser',
          'cognito-idp:AdminRemoveUserFromGroup',
          'cognito-idp:SetUserMFAPreference',
          'cognito-idp:SetUICustomization',
          'cognito-idp:SignUp',
          'cognito-idp:VerifyUserAttribute',
          'cognito-idp:SetRiskConfiguration',
          'cognito-idp:StartUserImportJob',
          'cognito-idp:AdminSetUserPassword',
          'cognito-idp:AssociateSoftwareToken',
          'cognito-idp:CreateResourceServer',
          'cognito-idp:RespondToAuthChallenge',
          'cognito-idp:CreateUserPoolClient',
          'cognito-idp:AdminUserGlobalSignOut',
          'cognito-idp:GlobalSignOut',
          'cognito-idp:AddCustomAttributes',
          'cognito-idp:CreateGroup',
          'cognito-idp:CreateUserPool',
          'cognito-idp:AdminForgetDevice',
          'cognito-idp:AdminAddUserToGroup',
          'cognito-idp:AdminRespondToAuthChallenge',
          'cognito-idp:ForgetDevice',
          'cognito-idp:CreateUserPoolDomain',
          'cognito-idp:AdminEnableUser',
          'cognito-idp:AdminUpdateDeviceStatus',
          'cognito-idp:StopUserImportJob',
          'cognito-idp:InitiateAuth',
          'cognito-idp:AdminInitiateAuth',
          'cognito-idp:AdminSetUserMFAPreference',
          'cognito-idp:ConfirmForgotPassword',
          'cognito-idp:SetUserSettings',
          'cognito-idp:VerifySoftwareToken',
          'cognito-idp:AdminDisableProviderForUser',
          'cognito-idp:SetUserPoolMfaConfig',
          'cognito-idp:ChangePassword',
          'cognito-idp:ConfirmDevice',
          'cognito-idp:AdminResetUserPassword',
          'cognito-idp:ResendConfirmationCode',
        );
        break;
      case 'update':
        actions.push(
          'cognito-idp:ForgotPassword',
          'cognito-idp:UpdateAuthEventFeedback',
          'cognito-idp:UpdateResourceServer',
          'cognito-idp:UpdateUserPoolClient',
          'cognito-idp:AdminUpdateUserAttributes',
          'cognito-idp:UpdateUserAttributes',
          'cognito-idp:UpdateUserPoolDomain',
          'cognito-idp:UpdateIdentityProvider',
          'cognito-idp:UpdateGroup',
          'cognito-idp:AdminUpdateAuthEventFeedback',
          'cognito-idp:UpdateDeviceStatus',
          'cognito-idp:UpdateUserPool',
        );
        break;
      case 'read':
        actions.push(
          'cognito-identity:Describe*',
          'cognito-identity:Get*',
          'cognito-identity:List*',
          'cognito-idp:Describe*',
          'cognito-idp:AdminGetDevice',
          'cognito-idp:AdminGetUser',
          'cognito-idp:AdminList*',
          'cognito-idp:List*',
          'cognito-sync:Describe*',
          'cognito-sync:Get*',
          'cognito-sync:List*',
          'iam:ListOpenIdConnectProviders',
          'iam:ListRoles',
          'sns:ListPlatformApplications',
        );
        break;
      case 'delete':
        actions.push(
          'cognito-idp:DeleteUserPoolDomain',
          'cognito-idp:DeleteResourceServer',
          'cognito-idp:DeleteGroup',
          'cognito-idp:AdminDeleteUserAttributes',
          'cognito-idp:DeleteUserPoolClient',
          'cognito-idp:DeleteUserAttributes',
          'cognito-idp:DeleteUserPool',
          'cognito-idp:AdminDeleteUser',
          'cognito-idp:DeleteIdentityProvider',
          'cognito-idp:DeleteUser',
        );
        break;
      default:
        console.log(`${crudOption} not supported`);
    }
  });

  let userPoolReference;

  const { amplifyMeta } = context.amplify.getProjectDetails();

  const authResource = _.get(amplifyMeta, [category, resourceName], undefined);

  if (!authResource) {
    throw new Error(`Cannot get resource: ${resourceName} from '${category}' category.`);
  }

  if (authResource.serviceType === 'imported') {
    const userPoolId = _.get(authResource, ['output', 'UserPoolId'], undefined);

    if (!userPoolId) {
      throw new Error(`Cannot read the UserPoolId attribute value from the output section of resource: '${resourceName}'.`);
    }

    userPoolReference = userPoolId;
  } else {
    userPoolReference = {
      Ref: `${category}${resourceName}UserPoolId`,
    };
  }

  policy = {
    Effect: 'Allow',
    Action: actions,
    Resource: [
      {
        'Fn::Join': ['', ['arn:aws:cognito-idp:', { Ref: 'AWS::Region' }, ':', { Ref: 'AWS::AccountId' }, ':userpool/', userPoolReference]],
      },
    ],
  };

  const attributes = ['UserPoolId'];

  return { policy, attributes };
}

module.exports = {
  serviceWalkthrough,
  userPoolProviders,
  parseOAuthCreds,
  structureOAuthMetadata,
  getIAMPolicies,
  identityPoolProviders,
};
