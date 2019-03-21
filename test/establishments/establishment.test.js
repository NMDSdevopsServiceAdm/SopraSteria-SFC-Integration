
// this test script runs through a few various different actions on a specific establishment (registers its own establishment)

// mock the general console loggers - removes unnecessary output while running
// global.console = {
//     log: jest.fn(),
//     warn: jest.fn(),
//     error: jest.fn()
// }

const supertest = require('supertest');
const querystring = require('querystring');
const faker = require('faker');
const baseEndpoint = 'http://localhost:3000/api';
const apiEndpoint = supertest(baseEndpoint);

// mocked real postcode/location data
const locations = require('../mockdata/locations').data;
const postcodes = require('../mockdata/postcodes').data;

const Random = require('../utils/random');
const uuidV4Regex = /^[A-F\d]{8}-[A-F\d]{4}-4[A-F\d]{3}-[89AB][A-F\d]{3}-[A-F\d]{12}$/i;
const nmdsIdRegex = /^[A-Z]1[\d]{6}$/i;  // G1001163

const registrationUtils = require('../utils/registration');
const laUtils = require('../utils/localAuthorities');

// change history validation
const validatePropertyChangeHistory = require('../utils/changeHistory').validatePropertyChangeHistory;
let MIN_TIME_TOLERANCE = process.env.TEST_DEV ? 1000 : 400;
let MAX_TIME_TOLERANCE = process.env.TEST_DEV ? 3000 : 1000;
const PropertiesResponses = {};

describe ("establishment", async () => {
    let cqcServices = null;
    let nonCqcServices = null;
    beforeAll(async () => {
        // clean the database
        if (process.env.CLEAN_DB) {
            await apiEndpoint.post('/test/clean')
            .send({})
            .expect(200);
        }

        // fetch the current set of CQC and non CQC services (to set main service)
        const cqcServicesResults = await apiEndpoint.get('/services/byCategory?cqc=true')
            .expect('Content-Type', /json/)
            .expect(200);
        cqcServices = cqcServicesResults.body;
            
        const nonCqcServicesResults = await apiEndpoint.get('/services/byCategory?cqc=false')
            .expect('Content-Type', /json/)
            .expect(200);
        nonCqcServices = nonCqcServicesResults.body;
    });

    beforeEach(async () => {
    });

    describe("Non CQC Establishment", async ( )=> {
        let site = null;
        let establishmentId = null;
        let establishmentUid = null;
        let primaryLocalAuthorityCustodianCode = null;
        let loginSuccess = null;
        let authToken = null;
        const newCapacityIDs = [];

        beforeAll(async () => {
            site =  registrationUtils.newNonCqcSite(postcodes[1], nonCqcServices);
            primaryLocalAuthorityCustodianCode = parseInt(postcodes[1].localCustodianCode);
        });

        it("should create a non-CQC registation", async () => {
            expect(site).not.toBeNull();
            expect(primaryLocalAuthorityCustodianCode).not.toBeNull();

            const nonCqcEstablishment = await apiEndpoint.post('/registration')
                .send([site])
                .expect('Content-Type', /json/)
                .expect(200);

            expect(nonCqcEstablishment.body.status).toEqual(1);
            expect(Number.isInteger(nonCqcEstablishment.body.establishmentId)).toEqual(true);
            expect(uuidV4Regex.test(nonCqcEstablishment.body.establishmentUid)).toEqual(true);
            expect(nonCqcEstablishment.body.primaryUser).toEqual(site.user.username);
            establishmentId = nonCqcEstablishment.body.establishmentId;
            establishmentUid = nonCqcEstablishment.body.establishmentUid;
        });

        it("should login using the given username", async () => {
            expect(establishmentId).not.toBeNull();

            // first login after registration
            const loginResponse = await apiEndpoint.post('/login')
                .send({
                    username: site.user.username,
                    password: 'Password00'
                })
                .expect('Content-Type', /json/)
                .expect(200);

            expect(loginResponse.body.establishment.id).toEqual(establishmentId);
            expect(loginResponse.body.establishment.uid).toEqual(establishmentUid);
            expect(loginResponse.body.establishment.isRegulated).toEqual(false);
            expect(nmdsIdRegex.test(loginResponse.body.establishment.nmdsId)).toEqual(true);
            expect(loginResponse.body.isFirstLogin).toEqual(true);
            expect(Number.isInteger(loginResponse.body.mainService.id)).toEqual(true);

            // login a second time and confirm revised firstLogin status
            const secondLoginResponse = await apiEndpoint.post('/login')
                .send({
                    username: site.user.username,
                    password: 'Password00'
                })
                .expect('Content-Type', /json/)
                .expect(200);
            
            expect(secondLoginResponse.body.isFirstLogin).toEqual(false);
            expect(secondLoginResponse.body.establishment.name).toEqual(site.locationName);
            expect(secondLoginResponse.body.mainService.name).toEqual(site.mainService);

            loginSuccess = secondLoginResponse.body;
            
            // assert and store the auth token
            authToken = secondLoginResponse.header.authorization;
            //console.log("TEST DEBUG - auth token: ", authToken)
        });

        it.skip("should update the employer type", async () => {
            expect(authToken).not.toBeNull();
            expect(establishmentId).not.toBeNull();

            const firstResponse = await apiEndpoint.get(`/establishment/${establishmentId}/employerType`)
                .set('Authorization', authToken)
                .expect('Content-Type', /json/)
                .expect(200);
            expect(firstResponse.body.id).toEqual(establishmentId);
            expect(firstResponse.body.uid).toEqual(establishmentUid);
            expect(firstResponse.body.name).toEqual(site.locationName);
            expect(firstResponse.body).not.toHaveProperty('employerType');

            let updateResponse = await apiEndpoint.post(`/establishment/${establishmentId}/employerType`)
                .set('Authorization', authToken)
                .send({
                    employerType : "Private Sector"
                })
                .expect('Content-Type', /json/)
                .expect(200);
            expect(updateResponse.body.id).toEqual(establishmentId);
            expect(updateResponse.body.name).toEqual(site.locationName);
            expect(updateResponse.body.employerType).toEqual('Private Sector');

            const secondResponse = await apiEndpoint.get(`/establishment/${establishmentId}/employerType`)
                .set('Authorization', authToken)
                .expect('Content-Type', /json/)
                .expect(200);
            expect(secondResponse.body.id).toEqual(establishmentId);
            expect(secondResponse.body.name).toEqual(site.locationName);
            expect(secondResponse.body.employerType).toEqual('Private Sector');

            // and now check change history
            await apiEndpoint.post(`/establishment/${establishmentId}/employerType`)
                .set('Authorization', authToken)
                .send({
                    employerType : 'Voluntary / Charity'
                })
                .expect('Content-Type', /json/)
                .expect(200);

            let requestEpoch = new Date().getTime();
            let changeHistory =  await apiEndpoint.get(`/establishment/${establishmentId}/employerType?history=full`)
                .set('Authorization', authToken)
                .expect('Content-Type', /json/)
                .expect(200);
            expect(changeHistory.body.employerType).toHaveProperty('lastSaved');
            expect(changeHistory.body.employerType.currentValue).toEqual('Voluntary / Charity');
            expect(changeHistory.body.employerType.lastSaved).toEqual(changeHistory.body.employerType.lastChanged);
            expect(changeHistory.body.employerType.lastSavedBy).toEqual(site.user.username);
            expect(changeHistory.body.employerType.lastChangedBy).toEqual(site.user.username);
            let updatedEpoch = new Date(changeHistory.body.updated).getTime();
            expect(Math.abs(requestEpoch-updatedEpoch)).toBeLessThan(MIN_TIME_TOLERANCE);   // allows for slight clock slew

            // test change history for both the rate and the value
            validatePropertyChangeHistory(
                'Employer Type',
                PropertiesResponses,
                changeHistory.body.employerType,
                'Voluntary / Charity',
                'Private Sector',
                site.user.username,
                requestEpoch,
                (ref, given) => {
                    return ref == given
                });
            let lastSavedDate = changeHistory.body.employerType.lastSaved;
            
            // now update the property but with same value - expect no change
            await apiEndpoint.post(`/establishment/${establishmentId}/employerType`)
                .set('Authorization', authToken)
                .send({
                    employerType : 'Voluntary / Charity'
                })
                .expect('Content-Type', /json/)
                .expect(200);
            changeHistory =  await apiEndpoint.get(`/establishment/${establishmentId}/employerType?history=property`)
                .set('Authorization', authToken)
                .expect('Content-Type', /json/)
                .expect(200);
            expect(changeHistory.body.employerType.currentValue).toEqual('Voluntary / Charity');
            expect(changeHistory.body.employerType.lastChanged).toEqual(new Date(lastSavedDate).toISOString());                             // lastChanged is equal to the previous last saved
            expect(new Date(changeHistory.body.employerType.lastSaved).getTime()).toBeGreaterThan(new Date(lastSavedDate).getTime());       // most recent last saved greater than the previous last saved

            // confirm expected values
            updateResponse = await apiEndpoint.post(`/establishment/${establishmentId}/employerType`)
                .set('Authorization', authToken)
                .send({
                    employerType : "Other"
                })
                .expect('Content-Type', /json/)
                .expect(200);
            expect(updateResponse.body.employerType).toEqual('Other');
            updateResponse = await apiEndpoint.post(`/establishment/${establishmentId}/employerType`)
                .set('Authorization', authToken)
                .send({
                    employerType : "Local Authority (generic/other)"
                })
                .expect('Content-Type', /json/)
                .expect(200);
            expect(updateResponse.body.employerType).toEqual('Local Authority (generic/other)');
            updateResponse = await apiEndpoint.post(`/establishment/${establishmentId}/employerType`)
                .set('Authorization', authToken)
                .send({
                    employerType : "Local Authority (adult services)"
                })
                .expect('Content-Type', /json/)
                .expect(200);
            expect(updateResponse.body.employerType).toEqual('Local Authority (adult services)');

            // now test for an unexpected employer type
            apiEndpoint.post(`/establishment/${establishmentId}/employerType`)
                .set('Authorization', authToken)
                .send({
                    employerType : "Unknown"
                })
                .expect('Content-Type', /text/)
                .expect(400)
                .end((err,res) => {
                    expect(res.text).toEqual('Unexpected Input.');
                    expect(res.error.status).toEqual(400);
                });
            
        });

        it.skip("should update the number of staff", async () => {
            expect(authToken).not.toBeNull();
            expect(establishmentId).not.toBeNull();

            const firstResponse = await apiEndpoint.get(`/establishment/${establishmentId}/staff`)
                .set('Authorization', authToken)
                .expect('Content-Type', /json/)
                .expect(200);
            expect(firstResponse.body.id).toEqual(establishmentId);
            expect(firstResponse.body.uid).toEqual(establishmentUid);
            expect(firstResponse.body.name).toEqual(site.locationName);
            expect(firstResponse.body).not.toHaveProperty('numberOfStaff');


            const newNumberOfStaff = Random.randomInt(1,999);
            let updateResponse = await apiEndpoint.post(`/establishment/${establishmentId}/staff/${newNumberOfStaff}`)
                .set('Authorization', authToken)
                .send({})
                .expect('Content-Type', /json/)
                .expect(200);
            expect(updateResponse.body.id).toEqual(establishmentId);
            expect(updateResponse.body.name).toEqual(site.locationName);
            expect(updateResponse.body.numberOfStaff).toEqual(newNumberOfStaff);

            // and now check change history
            let secondNumberOfStaff = Random.randomInt(1,998);
            if (secondNumberOfStaff === newNumberOfStaff) {
                secondNumberOfStaff = newNumberOfStaff+1;
            }
            await apiEndpoint.post(`/establishment/${establishmentId}/staff/${secondNumberOfStaff}`)
                .set('Authorization', authToken)
                .send({})
                .expect('Content-Type', /json/)
                .expect(200);
            
            const secondResponse = await apiEndpoint.get(`/establishment/${establishmentId}/staff`)
                .set('Authorization', authToken)
                .expect('Content-Type', /json/)
                .expect(200);
            expect(secondResponse.body.id).toEqual(establishmentId);
            expect(secondResponse.body.name).toEqual(site.locationName);
            expect(secondResponse.body.numberOfStaff).toEqual(secondNumberOfStaff);

            let requestEpoch = new Date().getTime();
            let changeHistory =  await apiEndpoint.get(`/establishment/${establishmentId}/staff?history=full`)
                .set('Authorization', authToken)
                .expect('Content-Type', /json/)
                .expect(200);
            expect(changeHistory.body.numberOfStaff).toHaveProperty('lastSaved');
            expect(changeHistory.body.numberOfStaff.currentValue).toEqual(secondNumberOfStaff);
            expect(changeHistory.body.numberOfStaff.lastSaved).toEqual(changeHistory.body.numberOfStaff.lastChanged);
            expect(changeHistory.body.numberOfStaff.lastSavedBy).toEqual(site.user.username);
            expect(changeHistory.body.numberOfStaff.lastChangedBy).toEqual(site.user.username);
            let updatedEpoch = new Date(changeHistory.body.updated).getTime();
            expect(Math.abs(requestEpoch-updatedEpoch)).toBeLessThan(MIN_TIME_TOLERANCE);   // allows for slight clock slew

            // test change history for both the rate and the value
            validatePropertyChangeHistory(
                'Number of Staff',
                PropertiesResponses,
                changeHistory.body.numberOfStaff,
                secondNumberOfStaff,
                newNumberOfStaff,
                site.user.username,
                requestEpoch,
                (ref, given) => {
                    return ref == given
                });
            let lastSavedDate = changeHistory.body.numberOfStaff.lastSaved;
            
            // now update the property but with same value - expect no change
            await apiEndpoint.post(`/establishment/${establishmentId}/staff/${secondNumberOfStaff}`)
                .set('Authorization', authToken)
                .send({})
                .expect('Content-Type', /json/)
                .expect(200);
            changeHistory =  await apiEndpoint.get(`/establishment/${establishmentId}/staff?history=property`)
                .set('Authorization', authToken)
                .expect('Content-Type', /json/)
                .expect(200);
            expect(changeHistory.body.numberOfStaff.currentValue).toEqual(secondNumberOfStaff);
            expect(changeHistory.body.numberOfStaff.lastChanged).toEqual(new Date(lastSavedDate).toISOString());                             // lastChanged is equal to the previous last saved
            expect(new Date(changeHistory.body.numberOfStaff.lastSaved).getTime()).toBeGreaterThan(new Date(lastSavedDate).getTime());       // most recent last saved greater than the previous last saved

            // // confirm expected values
            await apiEndpoint.post(`/establishment/${establishmentId}/staff/0`)
                .set('Authorization', authToken)
                .send({})
                .expect('Content-Type', /json/)
                .expect(200);
            await apiEndpoint.post(`/establishment/${establishmentId}/staff/999`)
                .set('Authorization', authToken)
                .send({})
                .expect('Content-Type', /json/)
                .expect(200);
            
            // now test for an out of range number of staff
            await apiEndpoint.post(`/establishment/${establishmentId}/staff/-1`)
                .set('Authorization', authToken)
                .send({})
                .expect(400);
            await apiEndpoint.post(`/establishment/${establishmentId}/staff/1000`)
                .set('Authorization', authToken)
                .send({})
                .expect(400);
            apiEndpoint.post(`/establishment/${establishmentId}/staff/1000`)
                .set('Authorization', authToken)
                .send({
                    employerType : "Unknown"
                })
                .expect('Content-Type', /text/)
                .expect(400)
                .end((err,res) => {
                    expect(res.text).toEqual('Unexpected Input.');
                    expect(res.error.status).toEqual(400);
                });
        });

        /*it.skip("should validate the list of all services returned on GET all=true", async () => {
        });
        it.skip("should validate the list of all services returned on GET all=true having updated services and confirming those which are my other service", async () => {
        });
        */

        it.skip("should update 'other' services", async () => {
            expect(authToken).not.toBeNull();
            expect(establishmentId).not.toBeNull();

            const firstResponse = await apiEndpoint.get(`/establishment/${establishmentId}/services?all=true`)
                .set('Authorization', authToken)
                .expect('Content-Type', /json/)
                .expect(200);
            expect(firstResponse.body.id).toEqual(establishmentId);
            expect(firstResponse.body.name).toEqual(site.locationName);
            expect(Number.isInteger(firstResponse.body.mainService.id)).toEqual(true);
            expect(firstResponse.body.mainService.name).toEqual(site.mainService);

            // before adding any services
            expect(Array.isArray(firstResponse.body.otherServices)).toEqual(true);
            expect(firstResponse.body.otherServices.length).toEqual(0);

            // we also called the get with all=true, so test 'allOtherServices'
            expect(Array.isArray(firstResponse.body.allOtherServices)).toEqual(true);
            

            // because the `other services` filters out the main service, the results are dependent on main service - so can't use a snapshot!
            // TODO - spend more time on validating the other services response here. For now, just assume there are one or more
            expect(firstResponse.body.allOtherServices.length).toBeGreaterThanOrEqual(1);

            // add new other services (not equal to the main service)
            const expectedNumberOfOtherServices = Random.randomInt(1,3);
            const nonCqcServicesResults = await apiEndpoint.get('/services/byCategory?cqc=false')
                .expect('Content-Type', /json/)
                .expect(200);
            
            // always leave the first of the non CQC services out - so this can be used for the second post
            let firstServiceId = null;
            const nonCqcServiceIDs = [];
            nonCqcServicesResults.body.forEach(thisServiceCategory => {
                thisServiceCategory.services.forEach(thisService => {
                    if (firstServiceId === null) {
                        firstServiceId = thisService.id;
                    }
                    // ignore the main service ID and service ID of 9/10 (these have two capacity questions and will always be used for a non-CQC establishment)
                    else if ((thisService.id !== firstResponse.body.mainService.id) && (thisService.id !== 9) && (thisService.id !== 10)) {
                        nonCqcServiceIDs.push(thisService.id);
                    }
                })
            });
            expect(nonCqcServiceIDs.length).toBeGreaterThan(0);

            // always use service ID of 9 or 10 (whichever is not the main service id)
            //   we also add a known CQC service to prove it is ignored (always the first!
            const newNonCQCServiceIDs = [
                {
                    id: firstResponse.body.mainService.id === 9 ? 10 : 9
                }
            ];
            for (let loopCount=0; loopCount < expectedNumberOfOtherServices; loopCount++) {
                // random can return the same index more than once; which will cause irratic failures on test
                let nextServiceId = null;
                while (nextServiceId === null) {
                    const testServiceId = nonCqcServiceIDs[Math.floor(Math.random() * nonCqcServiceIDs.length)];
                    if (!newNonCQCServiceIDs.find(existingService => existingService.id === testServiceId)) nextServiceId = testServiceId;
                } 

                newNonCQCServiceIDs.push({
                    id: nextServiceId
                });
            }
            expect(nonCqcServiceIDs.length).toBeGreaterThan(0);

            let updateResponse = await apiEndpoint.post(`/establishment/${establishmentId}/services`)
                .set('Authorization', authToken)
                .send({
                    services: newNonCQCServiceIDs
                })
                .expect('Content-Type', /json/)
                .expect(200);
            expect(updateResponse.body.id).toEqual(establishmentId);
            expect(updateResponse.body.name).toEqual(site.locationName);
            expect(Number.isInteger(updateResponse.body.mainService.id)).toEqual(true);
            expect(updateResponse.body.mainService.name).toEqual(site.mainService);
            expect(updateResponse.body).not.toHaveProperty('allOtherServices');

            // confirm the services
            expect(Array.isArray(updateResponse.body.otherServices)).toEqual(true);
            expect(updateResponse.body.otherServices.length).toBeGreaterThan(0);
            const fristSetOfOtherServices = updateResponse.body.otherServices;

            // and now check change history
            
            // to force a change on services, by always adding the first non CQC service
            //  which we removed from scope earlier
            const modifiedSetOfServices = newNonCQCServiceIDs.concat({
                id: firstServiceId
            });

            const secondPostResponse = await apiEndpoint.post(`/establishment/${establishmentId}/services`)
                .set('Authorization', authToken)
                .send({
                    services: modifiedSetOfServices
                })
                // .expect('Content-Type', /json/)
                // .expect(200);
            const secondSetOfOtherServices = secondPostResponse.body.otherServices;

            let requestEpoch = new Date().getTime();
            let changeHistory =  await apiEndpoint.get(`/establishment/${establishmentId}/services?history=full`)
                .set('Authorization', authToken)
                .expect('Content-Type', /json/)
                .expect(200);
            expect(changeHistory.body.otherServices).toHaveProperty('lastSaved');

            // the result of "otherServices" is a complex Array of objects that does not equal the
            //   array as input
            // validating that array is complicated
            // TODO: replace this excuse of a validation with a more thorough validation
            expect(Array.isArray(changeHistory.body.otherServices.currentValue)).toEqual(true);
            expect(changeHistory.body.otherServices.lastSaved).toEqual(changeHistory.body.otherServices.lastChanged);
            expect(changeHistory.body.otherServices.lastSavedBy).toEqual(site.user.username);
            expect(changeHistory.body.otherServices.lastChangedBy).toEqual(site.user.username);
            let updatedEpoch = new Date(changeHistory.body.updated).getTime();
            expect(Math.abs(requestEpoch-updatedEpoch)).toBeLessThan(MIN_TIME_TOLERANCE);   // allows for slight clock slew

            // test change history for both the rate and the value
            validatePropertyChangeHistory(
                'Other Services',
                PropertiesResponses,
                changeHistory.body.otherServices,
                secondSetOfOtherServices,
                fristSetOfOtherServices,
                site.user.username,
                requestEpoch,
                (ref, given) => {
                    return Array.isArray(ref)
                });
            let lastSavedDate = changeHistory.body.otherServices.lastSaved;
            
            // now update the property but with same value - expect no change
            await apiEndpoint.post(`/establishment/${establishmentId}/services`)
                .set('Authorization', authToken)
                .send({
                    services: modifiedSetOfServices
                })
                .expect('Content-Type', /json/)
                .expect(200);
            changeHistory =  await apiEndpoint.get(`/establishment/${establishmentId}/services?history=property`)
                .set('Authorization', authToken)
                .expect('Content-Type', /json/)
                .expect(200);
            expect(Array.isArray(changeHistory.body.otherServices.currentValue)).toEqual(true);
            expect(changeHistory.body.otherServices.lastChanged).toEqual(new Date(lastSavedDate).toISOString());                             // lastChanged is equal to the previous last saved
            expect(new Date(changeHistory.body.otherServices.lastSaved).getTime()).toBeGreaterThan(new Date(lastSavedDate).getTime());       // most recent last saved greater than the previous last saved
        
            // now test the get having updated 'other service'
            const secondResponse = await apiEndpoint.get(`/establishment/${establishmentId}/services`)
                .set('Authorization', authToken)
                .expect('Content-Type', /json/)
                .expect(200);
            expect(secondResponse.body.id).toEqual(establishmentId);
            expect(secondResponse.body.name).toEqual(site.locationName);
            const fetchedOtherServicesID = [];
            secondResponse.body.otherServices.forEach(thisServiceCategory => {
                thisServiceCategory.services.forEach(thisService => {
                    fetchedOtherServicesID.push(thisService.id);
                })
            });

            // and now test for expected validation failures
            await apiEndpoint.post(`/establishment/${establishmentId}/services`)
                .set('Authorization', authToken)
                .send({
                    services: {
                        id: "1"     // must be an integer
                    }
                })
                .expect(400);
            await apiEndpoint.post(`/establishment/${establishmentId}/services`)
                .set('Authorization', authToken)
                .send({
                    services: {
                        id: 100     // must be in range
                    }
                })
                .expect(400);
            await apiEndpoint.post(`/establishment/${establishmentId}/services`)
                .set('Authorization', authToken)
                .send({
                    services: {
                        iid: "1"     // must have "id" attribute
                    }
                })
                .expect(400);
        });

       /*  it.skip("should validate the list of all service capacities returned on GET all=true", async () => {
        });
        it.skip("should validate the list of all service capacities returned on GET all=true having updated capacities and confirming the answer", async () => {
        }); */
        it.skip("should update 'service capacities", async () => {
            expect(authToken).not.toBeNull();
            expect(establishmentId).not.toBeNull();

            const firstResponse = await apiEndpoint.get(`/establishment/${establishmentId}/capacity?all=true`)
                .set('Authorization', authToken)
                .expect('Content-Type', /json/)
                .expect(200);
            expect(firstResponse.body.id).toEqual(establishmentId);
            expect(firstResponse.body.name).toEqual(site.locationName);
            expect(Number.isInteger(firstResponse.body.mainService.id)).toEqual(true);
            expect(firstResponse.body.mainService.name).toEqual(site.mainService);

            // before adding any service capacities
            expect(Array.isArray(firstResponse.body.capacities)).toEqual(true);
            expect(firstResponse.body.capacities.length).toEqual(0);

            // we also called the get with all=true, so test 'allOtherServices'
            expect(Array.isArray(firstResponse.body.allServiceCapacities)).toEqual(true);
            

            // because the `service capacities` are dependent on the set of main and other services, and consequently their type in regards to how many (if any)
            //   service capacity questions there are, and if the main service has a set of capacities, validating the set of allServiceCapacities
            // TODO - spend more time on validating the allServiceCapacities response here. For now, just assume there are one or more
            //expect(firstResponse.body.allServiceCapacities.length).toBeGreaterThanOrEqual(1);

            // for now, assume the set of allServiceCapacities is valid

            // add new service capabilities, by randoming selecting a random number of capabilities from allServiceCapacities
            const availableCapacitiesToUpdate = [];
            firstResponse.body.allServiceCapacities.forEach(thisServiceCapacity => {
                thisServiceCapacity.questions.forEach(thisQuestion => {
                    availableCapacitiesToUpdate.push({
                        questionId: thisQuestion.questionId,
                        answer: Random.randomInt(1,999)
                    });
                })
            });
            // there could be no capacities - so ignore the test this time because backend validation prevent
            //  passing unexpected capacities
            if (availableCapacitiesToUpdate.length > 0) {
                let updateResponse = await apiEndpoint.post(`/establishment/${establishmentId}/capacity`)
                    .set('Authorization', authToken)
                    .send({
                        capacities: availableCapacitiesToUpdate
                    })
                    .expect('Content-Type', /json/)
                    .expect(200);
                expect(updateResponse.body.id).toEqual(establishmentId);
                expect(updateResponse.body.name).toEqual(site.locationName);
                expect(Number.isInteger(updateResponse.body.mainService.id)).toEqual(true);
                expect(updateResponse.body.mainService.name).toEqual(site.mainService);
                expect(updateResponse.body).not.toHaveProperty('allServiceCapacities');

                // confirm the expected capacities in the response
                expect(Array.isArray(updateResponse.body.capacities)).toEqual(true);
                expect(updateResponse.body.capacities.length).toEqual(availableCapacitiesToUpdate.length);

                // now confirm the get
                const secondResponse = await apiEndpoint.get(`/establishment/${establishmentId}/capacity`)
                    .set('Authorization', authToken)
                    .expect('Content-Type', /json/)
                    .expect(200);

                expect(secondResponse.body.id).toEqual(establishmentId);
                expect(secondResponse.body.name).toEqual(site.locationName);
                expect(Number.isInteger(secondResponse.body.mainService.id)).toEqual(true);
                expect(secondResponse.body.mainService.name).toEqual(site.mainService);
                expect(secondResponse.body).toHaveProperty('allServiceCapacities');
                expect(Array.isArray(secondResponse.body.allServiceCapacities)).toEqual(true);
                
                // the result of "otherServices" is a complex Array of objects that does not equal the
                //   array as input
                // validating that array is complicated
                // TODO: replace this excuse of a validation with a more thorough validation
                expect(Array.isArray(secondResponse.body.capacities)).toEqual(true);

                // but we cannot test length of allServiceCapacities because it can be zero or more!
                // /expect(secondResponse.body.allServiceCapacities.length).toEqual(0);
                expect(secondResponse.body.capacities.length).toEqual(availableCapacitiesToUpdate.length);

                // now update a second time - to test the audut change history
                const secondAvailableCapacitiesToUpdate = [];
                firstResponse.body.allServiceCapacities.forEach(thisServiceCapacity => {
                    thisServiceCapacity.questions.forEach(thisQuestion => {
                        secondAvailableCapacitiesToUpdate.push({
                            questionId: thisQuestion.questionId,
                            answer: Random.randomInt(1,999)
                        });
                    })
                });

                updateResponse = await apiEndpoint.post(`/establishment/${establishmentId}/capacity`)
                    .set('Authorization', authToken)
                    .send({
                        capacities: secondAvailableCapacitiesToUpdate
                    })
                    .expect('Content-Type', /json/)
                    .expect(200);
                expect(updateResponse.body.id).toEqual(establishmentId);
                expect(updateResponse.body.name).toEqual(site.locationName);
                expect(Number.isInteger(updateResponse.body.mainService.id)).toEqual(true);
                expect(updateResponse.body.mainService.name).toEqual(site.mainService);
                expect(updateResponse.body).not.toHaveProperty('allServiceCapacities');

                let requestEpoch = new Date().getTime();
                let changeHistory =  await apiEndpoint.get(`/establishment/${establishmentId}/capacity?history=full`)
                    .set('Authorization', authToken)
                    .expect('Content-Type', /json/)
                    .expect(200);
                expect(changeHistory.body.capacities).toHaveProperty('lastSaved');
    
                // the result of "capacities" is a complex Array of objects that does not equal the
                //   array as input
                // validating that array is complicated
                // TODO: replace this excuse of a validation with a more thorough validation
                expect(Array.isArray(changeHistory.body.capacities.currentValue)).toEqual(true);
                expect(changeHistory.body.capacities.lastSaved).toEqual(changeHistory.body.capacities.lastChanged);
                expect(changeHistory.body.capacities.lastSavedBy).toEqual(site.user.username);
                expect(changeHistory.body.capacities.lastChangedBy).toEqual(site.user.username);
                let updatedEpoch = new Date(changeHistory.body.updated).getTime();
                expect(Math.abs(requestEpoch-updatedEpoch)).toBeLessThan(MIN_TIME_TOLERANCE);   // allows for slight clock slew    

                // test change history for both the rate and the value
                validatePropertyChangeHistory(
                    'Capacity Services',
                    PropertiesResponses,
                    changeHistory.body.capacities,
                    secondAvailableCapacitiesToUpdate,
                    availableCapacitiesToUpdate,
                    site.user.username,
                    requestEpoch,
                    (ref, given) => {
                        return Array.isArray(ref)
                    });
                let lastSavedDate = changeHistory.body.capacities.lastSaved;
                
                // now update the property but with same value - expect no change
                await apiEndpoint.post(`/establishment/${establishmentId}/capacity`)
                    .set('Authorization', authToken)
                    .send({
                        capacities: secondAvailableCapacitiesToUpdate
                    })
                    .expect('Content-Type', /json/)
                    .expect(200);
                changeHistory =  await apiEndpoint.get(`/establishment/${establishmentId}/capacity?history=property`)
                    .set('Authorization', authToken)
                    .expect('Content-Type', /json/)
                    .expect(200);
                expect(Array.isArray(changeHistory.body.capacities.currentValue)).toEqual(true);
                expect(changeHistory.body.capacities.lastChanged).toEqual(new Date(lastSavedDate).toISOString());                             // lastChanged is equal to the previous last saved
                expect(new Date(changeHistory.body.capacities.lastSaved).getTime()).toBeGreaterThan(new Date(lastSavedDate).getTime());       // most recent last saved greater than the previous last saved

                // and now expect on validation error
                let validationErrorCapacity = [{
                    questionId: "1",     // must be an integer
                    answer: 10
                }];
                await apiEndpoint.post(`/establishment/${establishmentId}/capacity`)
                    .set('Authorization', authToken)
                    .send({
                        capacities: validationErrorCapacity
                    })
                    .expect(400);
                validationErrorCapacity = [{
                    questionId: 100,     // must be within range
                    answer: 10
                }];
                await apiEndpoint.post(`/establishment/${establishmentId}/capacity`)
                    .set('Authorization', authToken)
                    .send({
                        capacities: validationErrorCapacity
                    })
                    .expect(400);
                validationErrorCapacity = [{
                    qquestionId: secondAvailableCapacitiesToUpdate[0].questionId,     // must defined questionId
                    answer: 10
                }];
                await apiEndpoint.post(`/establishment/${establishmentId}/capacity`)
                    .set('Authorization', authToken)
                    .send({
                        capacities: validationErrorCapacity
                    })
                    .expect(400);

                validationErrorCapacity = [{
                    questionId: secondAvailableCapacitiesToUpdate[0].questionId,
                    aanswer: 10        // must be defined
                }];
                await apiEndpoint.post(`/establishment/${establishmentId}/capacity`)
                    .set('Authorization', authToken)
                    .send({
                        capacities: validationErrorCapacity
                    })
                    .expect(400);

                validationErrorCapacity = [{
                    questionId: secondAvailableCapacitiesToUpdate[0].questionId,
                    answer: "10"        //must be an integer
                }];
                await apiEndpoint.post(`/establishment/${establishmentId}/capacity`)
                    .set('Authorization', authToken)
                    .send({
                        capacities: validationErrorCapacity
                    })
                    .expect(400);

                validationErrorCapacity = [{
                    questionId: secondAvailableCapacitiesToUpdate[0].questionId,
                    answer: -1        // must be greater than equal to 0
                }];
                await apiEndpoint.post(`/establishment/${establishmentId}/capacity`)
                    .set('Authorization', authToken)
                    .send({
                        capacities: validationErrorCapacity
                    })
                    .expect(400);
                validationErrorCapacity = [{
                    questionId: secondAvailableCapacitiesToUpdate[0].questionId,
                    answer: 1000      // must be less than equal to 999
                }];
                await apiEndpoint.post(`/establishment/${establishmentId}/capacity`)
                    .set('Authorization', authToken)
                    .send({
                        capacities: validationErrorCapacity
                    })
                    .expect(400);
            
            }
        });

        it("should update the sharing options", async () => {
            expect(authToken).not.toBeNull();
            expect(establishmentId).not.toBeNull();

            const firstResponse = await apiEndpoint.get(`/establishment/${establishmentId}/share`)
                .set('Authorization', authToken)
                .expect('Content-Type', /json/)
                .expect(200);
            expect(firstResponse.body.id).toEqual(establishmentId);
            expect(firstResponse.body.name).toEqual(site.locationName);
            expect(firstResponse.body.share.enabled).toEqual(false);        // disabled (default) on registration

            // enable sharing (no options)
            let updateResponse = await apiEndpoint.post(`/establishment/${establishmentId}/share`)
                .set('Authorization', authToken)
                .send({
                    share : {
                        enabled : true
                    }
                })
                .expect('Content-Type', /json/)
                .expect(200);
            expect(updateResponse.body.id).toEqual(establishmentId);
            expect(updateResponse.body.name).toEqual(site.locationName);
            expect(updateResponse.body.share.enabled).toEqual(true);
            expect(Array.isArray(updateResponse.body.share.with)).toEqual(true);
            expect(updateResponse.body.share.with.length).toEqual(0);

            updateResponse = await apiEndpoint.get(`/establishment/${establishmentId}/share`)
                .set('Authorization', authToken)
                .expect('Content-Type', /json/)
                .expect(200);
            expect(updateResponse.body.id).toEqual(establishmentId);
            expect(updateResponse.body.name).toEqual(site.locationName);
            expect(updateResponse.body.share.enabled).toEqual(true);
            expect(Array.isArray(updateResponse.body.share.with)).toEqual(true);
            expect(updateResponse.body.share.with.length).toEqual(0);
    
            // with sharing enabled, add options
            updateResponse = await apiEndpoint.post(`/establishment/${establishmentId}/share`)
                .set('Authorization', authToken)
                .send({
                    share : {
                        enabled : true,
                        with : ['Local Authority']
                    }
                })
                .expect('Content-Type', /json/)
                .expect(200);
            expect(updateResponse.body.id).toEqual(establishmentId);
            expect(updateResponse.body.name).toEqual(site.locationName);
            expect(updateResponse.body.share.enabled).toEqual(true);
            expect(Array.isArray(updateResponse.body.share.with)).toEqual(true);
            expect(updateResponse.body.share.with.length).toEqual(1);
            expect(updateResponse.body.share.with[0]).toEqual('Local Authority');

            updateResponse = await apiEndpoint.get(`/establishment/${establishmentId}/share`)
                .set('Authorization', authToken)
                .expect('Content-Type', /json/)
                .expect(200);
            expect(updateResponse.body.id).toEqual(establishmentId);
            expect(updateResponse.body.name).toEqual(site.locationName);
            expect(updateResponse.body.share.enabled).toEqual(true);
            expect(Array.isArray(updateResponse.body.share.with)).toEqual(true);
            expect(updateResponse.body.share.with.length).toEqual(1);
            expect(updateResponse.body.share.with[0]).toEqual('Local Authority');


            // and now check change history
            let requestEpoch = new Date().getTime();
            let changeHistory =  await apiEndpoint.get(`/establishment/${establishmentId}/share?history=full`)
                .set('Authorization', authToken)
                .expect('Content-Type', /json/)
                .expect(200);
            
            expect(changeHistory.body.share).toHaveProperty('lastSaved');
            expect(changeHistory.body.share.currentValue.enabled).toEqual(true);
            expect(changeHistory.body.share.currentValue.with[0]).toEqual('Local Authority');
            expect(changeHistory.body.share.lastSaved).toEqual(changeHistory.body.share.lastChanged);
            expect(changeHistory.body.share.lastSavedBy).toEqual(site.user.username);
            expect(changeHistory.body.share.lastChangedBy).toEqual(site.user.username);
            let updatedEpoch = new Date(changeHistory.body.updated).getTime();
            expect(Math.abs(requestEpoch-updatedEpoch)).toBeLessThan(MIN_TIME_TOLERANCE);   // allows for slight clock slew

            // test change history for both the rate and the value
            validatePropertyChangeHistory(
                'Share Options',
                PropertiesResponses,
                changeHistory.body.share,
                {
                    enabled : true,
                    with : ['Local Authority']
                },
                {
                    enabled : true
                },
                site.user.username,
                requestEpoch,
                (ref, given) => {
                    if (ref.enabled == given.enabled) {
                        if (ref.with && given.with) {
                            if (ref.with[0] && given.with[0] && ref.with[0] === given.with[0]) {
                                return true;
                            } else if (ref.with[0] && given.with[0]) {
                                return false;
                            } else {
                                return true;
                            }
                        } else if (ref.with || given.with) {
                            return true;
                        } else {
                            return true;
                        }
                    } else {
                        return false;
                    }
                });
            let lastSavedDate = changeHistory.body.share.lastSaved;
            
            // now update the property but with same value - expect no change
            await apiEndpoint.post(`/establishment/${establishmentId}/share`)
                .set('Authorization', authToken)
                .send({
                    share : {
                        enabled : true,
                        with : ['Local Authority']
                    }
                })
                .expect('Content-Type', /json/)
                .expect(200);
            changeHistory =  await apiEndpoint.get(`/establishment/${establishmentId}/share?history=property`)
                .set('Authorization', authToken)
                .expect('Content-Type', /json/)
                .expect(200);
            expect(changeHistory.body.share.currentValue.enabled).toEqual(true);
            expect(changeHistory.body.share.currentValue.with[0]).toEqual('Local Authority');
            expect(changeHistory.body.share.lastChanged).toEqual(new Date(lastSavedDate).toISOString());                             // lastChanged is equal to the previous last saved
            expect(new Date(changeHistory.body.share.lastSaved).getTime()).toBeGreaterThan(new Date(lastSavedDate).getTime());       // most recent last saved greater than the previous last saved


            // now disable sharing - provide with options, but they will be ignored
            updateResponse = await apiEndpoint.post(`/establishment/${establishmentId}/share`)
                .set('Authorization', authToken)
                .send({
                    share : {
                        enabled : false,
                        with : ["CQC"]
                    }
                })
                .expect('Content-Type', /json/)
                .expect(200);
            expect(updateResponse.body.id).toEqual(establishmentId);
            expect(updateResponse.body.name).toEqual(site.locationName);
            expect(updateResponse.body.share.enabled).toEqual(false);

            updateResponse = await apiEndpoint.get(`/establishment/${establishmentId}/share`)
                .set('Authorization', authToken)
                .expect('Content-Type', /json/)
                .expect(200);
            expect(updateResponse.body.id).toEqual(establishmentId);
            expect(updateResponse.body.name).toEqual(site.locationName);
            expect(updateResponse.body.share.enabled).toEqual(false);

            // now re-enable sharing (no options), they should be as they were before being disabled
            updateResponse = await apiEndpoint.post(`/establishment/${establishmentId}/share`)
                .set('Authorization', authToken)
                .send({
                    share : {
                        enabled : true
                    }
                })
                .expect('Content-Type', /json/)
                .expect(200);
            expect(updateResponse.body.id).toEqual(establishmentId);
            expect(updateResponse.body.name).toEqual(site.locationName);
            expect(updateResponse.body.share.enabled).toEqual(true);
            expect(Array.isArray(updateResponse.body.share.with)).toEqual(true);
            expect(updateResponse.body.share.with.length).toEqual(1);

            updateResponse = await apiEndpoint.get(`/establishment/${establishmentId}/share`)
                .set('Authorization', authToken)
                .expect('Content-Type', /json/)
                .expect(200);
            expect(updateResponse.body.id).toEqual(establishmentId);
            expect(updateResponse.body.name).toEqual(site.locationName);
            expect(updateResponse.body.share.enabled).toEqual(true);
            expect(Array.isArray(updateResponse.body.share.with)).toEqual(true);
            expect(updateResponse.body.share.with.length).toEqual(1);
            expect(updateResponse.body.share.with[0]).toEqual('Local Authority');

            // now expect failed validation
            await apiEndpoint.post(`/establishment/${establishmentId}/share`)
                .set('Authorization', authToken)
                .send({
                    share : {
                        enabled : "false",          // need to be boolean
                        with : ["CQC"]
                    }
                })
                .expect(400);
            await apiEndpoint.post(`/establishment/${establishmentId}/share`)
                .set('Authorization', authToken)
                .send({
                    share : {
                        enabled : true,
                        with : ["unexpected"]   // only fixed values allowed
                    }
                })
                .expect(400);
            await apiEndpoint.post(`/establishment/${establishmentId}/share`)
                .set('Authorization', authToken)
                .send({
                    share : {
                        eenabled : false,       // enabled property must be defined
                        with : ["CQC"]
                    }
                })
                .expect(400);
        });

        /*
        it("should update the Local Authorities Share Options", async () => {
            expect(authToken).not.toBeNull();
            expect(establishmentId).not.toBeNull();

            const primaryAuthority = await apiEndpoint.get('/localAuthority/' + escape(site.postalCode));
            const primaryLocalAuthorityCustodianCode = primaryAuthority.body && primaryAuthority.body.id ? primaryAuthority.body.id : null;

            const firstResponse = await apiEndpoint.get(`/establishment/${establishmentId}/localAuthorities`)
                .set('Authorization', authToken)
                .expect('Content-Type', /json/)
                .expect(200);

            expect(firstResponse.body.id).toEqual(establishmentId);
            expect(firstResponse.body.name).toEqual(site.locationName);

            // primary authority may not always resolve
            if (primaryLocalAuthorityCustodianCode) {
                expect(firstResponse.body.primaryAuthority.custodianCode).toEqual(primaryLocalAuthorityCustodianCode);
                expect(firstResponse.body.primaryAuthority).toHaveProperty('name');     // we cannot validate the name of the Local Authority - this is not known in reference data
            }

            // before update expect the "localAuthorities" attribute as an array but it will be empty
            expect(Array.isArray(firstResponse.body.localAuthorities)).toEqual(true);
            expect(firstResponse.body.localAuthorities.length).toEqual(0);

            // assume the main and just one other (random) authority to set, along with some dodgy data to ignore
            const randomAuthorityCustodianCode = await laUtils.lookupRandomAuthority(apiEndpoint);
            const updateAuthorities = [
                {
                    name: "WOZILAND",
                    notes: "ignored because no custodianCode field"
                },
                {
                    custodianCode: primaryLocalAuthorityCustodianCode
                },
                {
                    custodianCode: "abc",
                    notes: "Ignored because custodianCode is not an integer"
                }
            ];
            updateAuthorities.push({
                custodianCode: randomAuthorityCustodianCode
            })
            let updateResponse = await apiEndpoint.post(`/establishment/${establishmentId}/localAuthorities`)
                .set('Authorization', authToken)
                .send({
                    "localAuthorities" : updateAuthorities
                })
                .expect('Content-Type', /json/)
                .expect(200);

            expect(updateResponse.body.id).toEqual(establishmentId);
            expect(updateResponse.body.name).toEqual(site.locationName);

            // but localAuthority is and should include only the main and random authority only (everything else ignored)
            expect(Array.isArray(updateResponse.body.localAuthorities)).toEqual(true);
            expect(updateResponse.body.localAuthorities.length).toEqual(2);
            const foundMainAuthority = updateResponse.body.localAuthorities.find(thisLA => thisLA.custodianCode === primaryAuthority.id);
            const foundRandomAuthority = updateResponse.body.localAuthorities.find(thisLA => thisLA.custodianCode === randomAuthorityCustodianCode);

            expect(foundMainAuthority !== null && foundRandomAuthority !== null).toEqual(true);
    
            updateResponse = await apiEndpoint.get(`/establishment/${establishmentId}/localAuthorities`)
                .set('Authorization', authToken)
                .expect('Content-Type', /json/)
                .expect(200);
            expect(updateResponse.body.id).toEqual(establishmentId);
            expect(updateResponse.body.name).toEqual(site.locationName);
            expect(Number.isInteger(updateResponse.body.primaryAuthority.custodianCode)).toEqual(true);
            expect(updateResponse.body.primaryAuthority).toHaveProperty('name');

            // before update expect the "localAuthorities" attribute as an array but it will be empty
            expect(Array.isArray(updateResponse.body.localAuthorities)).toEqual(true);
            expect(updateResponse.body.localAuthorities.length).toEqual(2);
        });

        it("should update the number of vacancies, starters and leavers", async () => {
            expect(authToken).not.toBeNull();
            expect(establishmentId).not.toBeNull();

            let jobsResponse = await apiEndpoint.get(`/establishment/${establishmentId}/jobs`)
                .set('Authorization', authToken)
                .expect('Content-Type', /json/)
                .expect(200);
            expect(jobsResponse.body.id).toEqual(establishmentId);
            expect(jobsResponse.body.name).toEqual(site.locationName);
            expect(jobsResponse.body.jobs.TotalVacencies).toEqual(0);
            expect(jobsResponse.body.jobs.TotalStarters).toEqual(0);
            expect(jobsResponse.body.jobs.TotalLeavers).toEqual(0);

            jobsResponse = await apiEndpoint.post(`/establishment/${establishmentId}/jobs`)
                .set('Authorization', authToken)
                .send({
                    jobs: {
                        vacancies: [
                            {
                                "jobId" : 1,
                                "total" : 999
                            },
                            {
                                "jobId" : 2,
                                "total" : 1000,
                            },
                            {
                                "jobId" : 10,
                                "total" : 333
                            },
                            {
                                "jobId" : "18",
                                "total" : 22
                            }
                        ]
                    }
                })
                .expect('Content-Type', /json/)
                .expect(200);
            expect(jobsResponse.body.id).toEqual(establishmentId);
            expect(jobsResponse.body.name).toEqual(site.locationName);
            expect(jobsResponse.body.jobs.TotalVacencies).toEqual(1332);
            expect(jobsResponse.body.jobs.TotalStarters).toEqual(0);
            expect(jobsResponse.body.jobs.TotalLeavers).toEqual(0);

            jobsResponse = await apiEndpoint.post(`/establishment/${establishmentId}/jobs`)
                .set('Authorization', authToken)
                .send({
                    jobs: {
                        starters: [
                            {
                                "jobId" : 17,
                                "total" : 43
                            },
                            {
                                "id" : 1,
                                "total" : 4
                            },
                            {
                                "jobId" : 2,
                                "total" : 1000,
                            },
                            {
                                "jobId" : 11,
                                "total" : 756
                            }
                        ]
                    }
                })
                .expect('Content-Type', /json/)
                .expect(200);
            expect(jobsResponse.body.id).toEqual(establishmentId);
            expect(jobsResponse.body.name).toEqual(site.locationName);
            expect(jobsResponse.body.jobs.TotalVacencies).toEqual(1332);
            expect(jobsResponse.body.jobs.TotalStarters).toEqual(799);
            expect(jobsResponse.body.jobs.TotalLeavers).toEqual(0);

            
            jobsResponse = await apiEndpoint.post(`/establishment/${establishmentId}/jobs`)
                .set('Authorization', authToken)
                .send({
                    jobs: {
                        vacancies: [],
                        leavers: [
                            {
                                "jobId" : 12,
                                "total" : 1000,
                            },
                            {
                                "jobId" : 9,
                                "total" : 111
                            },
                            {
                                "jobId" : 14,
                                "total" : 11
                            }
                        ]
                    }
                })
                .expect('Content-Type', /json/)
                .expect(200);
            expect(jobsResponse.body.id).toEqual(establishmentId);
            expect(jobsResponse.body.name).toEqual(site.locationName);
            expect(jobsResponse.body.jobs.TotalVacencies).toEqual(0);
            expect(jobsResponse.body.jobs.TotalStarters).toEqual(799);
            expect(jobsResponse.body.jobs.TotalLeavers).toEqual(122);


            jobsResponse = await apiEndpoint.post(`/establishment/${establishmentId}/jobs`)
                .set('Authorization', authToken)
                .send({
                    jobs: {
                        leavers: []
                    }
                })
                .expect('Content-Type', /json/)
                .expect(200);
            expect(jobsResponse.body.id).toEqual(establishmentId);
            expect(jobsResponse.body.name).toEqual(site.locationName);
            expect(jobsResponse.body.jobs.TotalVacencies).toEqual(0);
            expect(jobsResponse.body.jobs.TotalStarters).toEqual(799);
            expect(jobsResponse.body.jobs.TotalLeavers).toEqual(0);

            // in addition to providing a set of jobs for each of vacancies, starters and leavers
            //  can provide a declarative statement of "None" or "Don't know"
            jobsResponse = await apiEndpoint.post(`/establishment/${establishmentId}/jobs`)
                .set('Authorization', authToken)
                .send({
                    jobs: {
                        leavers: "None",
                        starters : "Don't know"
                    }
                })
                .expect('Content-Type', /json/)
                .expect(200);
            expect(jobsResponse.body.id).toEqual(establishmentId);
            expect(jobsResponse.body.name).toEqual(site.locationName);
            expect(jobsResponse.body.jobs.Leavers).toEqual('None');
            expect(jobsResponse.body.jobs.Starters).toEqual("Don't know");
            expect(jobsResponse.body.jobs.TotalVacencies).toEqual(0);
            expect(jobsResponse.body.jobs.TotalStarters).toEqual(0);
            expect(jobsResponse.body.jobs.TotalLeavers).toEqual(0);

            // forcing validation errors
            await apiEndpoint.post(`/establishment/${establishmentId}/jobs`)
                .set('Authorization', authToken)
                .send({
                    jobs: {
                        leavers: "Nne"
                    }
                })
                .expect('Content-Type', /html/)
                .expect(400);
            await apiEndpoint.post(`/establishment/${establishmentId}/jobs`)
                .set('Authorization', authToken)
                .send({
                    jobs: {
                        starters: "Don't Know"
                    }
                })
                .expect('Content-Type', /html/)
                .expect(400);
            await apiEndpoint.post(`/establishment/${establishmentId}/jobs`)
                .set('Authorization', authToken)
                .send({
                    jobs: {
                        vacancies: {
                            jobId: 1,
                            total: 1
                        }
                    }
                })
                .expect('Content-Type', /html/)
                .expect(400);
        });

        it("should get the Establishment", async () => {
            expect(authToken).not.toBeNull();
            expect(establishmentId).not.toBeNull();

            const firstResponse = await apiEndpoint.get(`/establishment/${establishmentId}`)
                .set('Authorization', authToken)
                .expect('Content-Type', /json/)
                .expect(200);
            expect(firstResponse.body.id).toEqual(establishmentId);
            expect(firstResponse.body.uid).toEqual(establishmentUid);

            // create/update tracking
            expect(firstResponse.body.created).toEqual(new Date(firstResponse.body.created).toISOString());
            expect(firstResponse.body.updated).toEqual(new Date(firstResponse.body.updated).toISOString());
            expect(firstResponse.body.updatedBy).toEqual(site.user.username);

            expect(firstResponse.body.name).toEqual(site.locationName);
            expect(nmdsIdRegex.test(firstResponse.body.nmdsId)).toEqual(true);
            expect(firstResponse.body.postcode).toEqual(site.postalCode);
            expect(firstResponse.body.isRegulated).toEqual(false);
            expect(firstResponse.body.address).not.toBeNull();
            expect(firstResponse.body.mainService).not.toBeNull();
            expect(Number.isInteger(firstResponse.body.mainService.id)).toEqual(true);
            expect(firstResponse.body.mainService.name).not.toBeNull();

            expect(firstResponse.body.numberOfStaff).not.toBeNull();
            expect(firstResponse.body.numberOfStaff).toBeGreaterThan(0);
            expect(Number.isInteger(firstResponse.body.mainService.id)).toEqual(true);
            expect(firstResponse.body.mainService.name).toEqual(site.mainService);
            expect(firstResponse.body.share.enabled).toEqual(true);
            expect(firstResponse.body.share.with[0]).toEqual('Local Authority');
            expect(firstResponse.body.jobs.TotalVacencies).toEqual(0);
            expect(firstResponse.body.jobs.TotalStarters).toEqual(0);
            expect(firstResponse.body.jobs.TotalLeavers).toEqual(0);
            expect(Array.isArray(firstResponse.body.otherServices)).toEqual(true);
            expect(firstResponse.body.otherServices.length).toBeGreaterThan(0);
            expect(Array.isArray(firstResponse.body.share.authorities)).toEqual(true);
            expect(firstResponse.body.share.authorities.length).toEqual(2);

            expect(Array.isArray(firstResponse.body.capacities)).toEqual(true);
            expect(firstResponse.body.capacities.length).toEqual(newCapacityIDs.length);
            newCapacityIDs.forEach(thisExpectedCapacity => {
                const foundCapacity = firstResponse.body.capacities.find(thisCapacity => thisCapacity.questionId === thisExpectedCapacity.questionId);
                expect(foundCapacity !== null).toEqual(true);
            });
        });

        it.skip('should get establishment with property history', async () => {
        });

        it('should get user with timeline history', async () => {
            expect(authToken).not.toBeNull();
            expect(establishmentId).not.toBeNull();

            const firstResponse = await apiEndpoint.get(`/establishment/${establishmentId}?history=timeline`)
                .set('Authorization', authToken)
                .expect('Content-Type', /json/)
                .expect(200);
            expect(firstResponse.body.id).toEqual(establishmentId);
            expect(firstResponse.body.uid).toEqual(establishmentUid);
            expect(firstResponse.body.name).toEqual(site.locationName);

            // create/update tracking
            expect(firstResponse.body.created).toEqual(new Date(firstResponse.body.created).toISOString());
            expect(firstResponse.body.updated).toEqual(new Date(firstResponse.body.updated).toISOString());
            expect(firstResponse.body.updatedBy).toEqual(site.user.username);

            expect(firstResponse.body).toHaveProperty('history');
            expect(Array.isArray(firstResponse.body.history)).toEqual(true);
            expect(firstResponse.body.history.length).toBeGreaterThan(0);

            // all updated events should have no propery or change
            const createdEvents = firstResponse.body.history.filter(thisEvent => {
                return thisEvent.event == 'created';
            });
            //console.log("TEST DEBUG: Created event: ", createdEvents[0].change);
            expect(createdEvents.length).toEqual(1);
            expect(createdEvents[0].username).toEqual(site.user.username);
            expect(createdEvents[0].change).toBeNull();
            expect(createdEvents[0].property).toBeNull();
            expect(createdEvents[0].when).toEqual(new Date(createdEvents[0].when).toISOString());
        });

        it('should get user with full history', async () => {
            expect(authToken).not.toBeNull();
            expect(establishmentId).not.toBeNull();

            const firstResponse = await apiEndpoint.get(`/establishment/${establishmentId}?history=full`)
                .set('Authorization', authToken)
                .expect('Content-Type', /json/)
                .expect(200);
            expect(firstResponse.body.id).toEqual(establishmentId);
            expect(firstResponse.body.uid).toEqual(establishmentUid);
            expect(firstResponse.body.name).toEqual(site.locationName);
            expect(nmdsIdRegex.test(firstResponse.body.nmdsId)).toEqual(true);
            expect(firstResponse.body.postcode).toEqual(site.postalCode);
            expect(firstResponse.body.isRegulated).toEqual(false);
            expect(firstResponse.body.address).not.toBeNull();
            expect(firstResponse.body.mainService).not.toBeNull();
            expect(Number.isInteger(firstResponse.body.mainService.id)).toEqual(true);
            expect(firstResponse.body.mainService.name).not.toBeNull();


            // create/update tracking
            expect(firstResponse.body.created).toEqual(new Date(firstResponse.body.created).toISOString());
            expect(firstResponse.body.updated).toEqual(new Date(firstResponse.body.updated).toISOString());
            expect(firstResponse.body.updatedBy).toEqual(site.user.username);

            expect(firstResponse.body).toHaveProperty('history');
            expect(Array.isArray(firstResponse.body.history)).toEqual(true);
            expect(firstResponse.body.history.length).toBeGreaterThan(0);

            // all updated events should have no propery or change
            const createdEvents = firstResponse.body.history.filter(thisEvent => {
                return thisEvent.event == 'created';
            });
            //console.log("TEST DEBUG: Created event: ", createdEvents[0]);
            expect(createdEvents.length).toEqual(1);
            expect(createdEvents[0].username).toEqual(site.user.username);
            expect(createdEvents[0]).not.toHaveProperty('change');
            expect(createdEvents[0]).not.toHaveProperty('property');
            expect(createdEvents[0].when).toEqual(new Date(createdEvents[0].when).toISOString());
        });
*/

        it("should report on response times", () => {
            const properties = Object.keys(PropertiesResponses);
            let consoleOutput = '';
            properties.forEach(thisProperty => {
                consoleOutput += `\x1b[0m\x1b[33m${thisProperty.padEnd(35, '.')}\x1b[37m\x1b[2m${PropertiesResponses[thisProperty]} ms\n`;
            });
            console.log(consoleOutput);
        });
    });

    describe.skip("CQC Establishment", async ( )=> {
        // it("should create a CQC registation", async () => {
        //     const cqcSite = registrationUtils.newCqcSite(locations[0], cqcServices);
        //     apiEndpoint.post('/registration')
        //         .send([cqcSite])
        //         .expect('Content-Type', /json/)
        //         .expect(200)
        //         .end((err, res) => {
        //             if (err) {
        //                 console.error(err);
        //             }
        //             console.log(res.body);
        //     });
        // });

        // include only tests that differ to those of a non-CQC establishment; namely "other services" and "share" (because wanting to share with CQC)

        // NOTE - location mock data does not include a "local custodian code" making it difficult to test 'service capacity' for a CQC site (but
        //        the code does not differentiate implementation for a CQC site; it simply works from the associated 'other services'). Could test by
        //        assuming the "primaryAuthority" returned in the GET is correct (as tested for a non-CQC site - that look up is the same regardless
        //        of establishment.isRegulated)
    });

    describe.skip("Establishment forced failures", async () => {
        describe("Employer Type", async () => {
            it("should fail (401) when attempting to update 'employer type' without passing Authorization header", async () => {});
            it("should fail (403) when attempting to update 'employer type' passing Authorization header with mismatched establishment id", async () => {});
            it("should fail (503) when attempting to update 'employer type' with unexpected server error", async () => {});
            it("should fail (400) when attempting to update 'employer type' with unexpected employer type", async () => {});
            it("should fail (400) when attempting to update 'employer type' with unexpected request format (JSON Schema)", async () => {});
        });
        describe("Other Services", async () => {
            it("should fail (401) when attempting to update 'other services' without passing Authorization header", async () => {});
            it("should fail (403) when attempting to update 'other services' passing Authorization header with mismatched establishment id", async () => {});
            it("should fail (503) when attempting to update 'other services' with unexpected server error", async () => {});
            it("should fail (400) when trying to update 'other services' with duplicates", async () => {});
            it("should fail (400) when trying to update 'other services' using 'main service'", async () => {});
            it("should fail (400) when attempting to update 'other services' with unexpected request format (JSON Schema)", async () => {})
        });
        describe("Service Capacities", async () => {
            it("should fail (401) when attempting to update 'services capacities' without passing Authorization header", async () => {});
            it("should fail (403) when attempting to update 'services capacities' passing Authorization header with mismatched establishment id", async () => {});
            it("should fail (503) when attempting to update 'services capacities' with unexpected server error", async () => {});
            it("should fail (400) when trying to update 'services capacities' with duplicates", async () => {});
            it("should fail (400) when attempting to update 'services capacities' with unexpected request format (JSON Schema)", async () => {})
        });
    });

});