/*
 * Copyright (C) 2024 Puter Technologies Inc.
 *
 * This file is part of Puter.
 *
 * Puter is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
const { Context } = require("../../util/context");
const APIError = require("../../api/APIError");
const { DriverError } = require("./DriverError");
const { TypedValue } = require("./meta/Runtime");
const BaseService = require("../BaseService");
const { Driver } = require("../../definitions/Driver");

/**
 * DriverService provides the functionality of Puter drivers.
 */
class DriverService extends BaseService {
    static MODULES = {
        types: require('./types'),
    }

    _construct () {
        this.drivers = {};
        this.interface_to_implementation = {};
    }
    
    async ['__on_registry.collections'] (_, { svc_registry }) {
        svc_registry.register_collection('interfaces');
        svc_registry.register_collection('drivers');
    }
    async ['__on_registry.entries'] (_, { svc_registry }) {
        const services = this.services;
        const col_interfaces = svc_registry.get('interfaces');
        const col_drivers = svc_registry.get('drivers');
        {
            const default_interfaces = require('./interfaces');
            for ( const k in default_interfaces ) {
                col_interfaces.set(k, default_interfaces[k]);
            }
        }
        await services.emit('driver.register.interfaces',
            { col_interfaces });
        await services.emit('driver.register.drivers',
            { col_drivers });
    }
    
    _init () {
        const svc_registry = this.services.get('registry');
        svc_registry.register_collection('');
    }

    register_driver (interface_name, implementation) {
        this.interface_to_implementation[interface_name] = implementation;
    }
    
    get_interface (interface_name) {
        const o = {};
        const col_interfaces = svc_registry.get('interfaces');
        const keys = col_interfaces.keys();
        for ( const k of keys ) o[k] = col_interfaces.get(k);
        return col_interfaces.get(interface_name);
    }
    
    get_default_implementation (interface_name) {
        // If there's a hardcoded implementation, use that
        // (^ temporary, until all are migrated)
        if (this.interface_to_implementation.hasOwnProperty(interface_name)) {
            return this.interface_to_implementation[interface_name];
        }
        
        this.log.noticeme('HERE IT IS');
        const options = this.services.get_implementors(interface_name);
        this.log.info('test', { options });
        if ( options.length < 1 ) return;
        return options[0];
    }

    async call (...a) {
        try {
            return await this._call(...a);
        } catch ( e ) {
            console.error(e);
            return this._driver_response_from_error(e);
        }
    }

    async _call (interface_name, method, args) {
        const processed_args = await this._process_args(interface_name, method, args);
        if ( Context.get('test_mode') ) {
            processed_args.test_mode = true;
        }

        const actor = Context.get('actor');
        if ( ! actor ) {
            throw Error('actor not found in context');
        }

        const services = Context.get('services');
        const svc_permission = services.get('permission');

        const perm = await svc_permission.check(actor, `driver:${interface_name}:${method}`);
        if ( ! perm ) {
            throw APIError.create('permission_denied');
        }

        const svc_registry = this.services.get('registry');
        const c_interfaces = svc_registry.get('interfaces');

        const instance = this.get_default_implementation(interface_name);
        if ( ! instance ) {
            throw APIError.create('no_implementation_available', null, { interface_name })
        }
        const meta = await (async () => {
            if ( instance instanceof Driver ) {
                return await instance.get_response_meta();
            }
            if ( ! instance.instance.as('driver-metadata') ) return;
            const t = instance.instance.as('driver-metadata');
            return t.get_response_meta();
        })();
        try {
            let result;
            if ( instance instanceof Driver ) {
                result = await instance.call(
                    method, processed_args);
            } else {
                // TODO: SLA and monthly limits do not apply do drivers
                //       from service traits (yet)
                result = await instance.impl[method](processed_args);
            }
            if ( result instanceof TypedValue ) {
                const interface_ = c_interfaces.get(interface_name);
                let desired_type = interface_.methods[method]
                    .result_choices[0].type;
                const svc_coercion = services.get('coercion');
                result = await svc_coercion.coerce(desired_type, result);
                // meta.type = result.type.toString(),
            }
            return { success: true, ...meta, result };
        } catch ( e ) {
            let for_user = (e instanceof APIError) || (e instanceof DriverError);
            if ( ! for_user ) this.errors.report(`driver:${interface_name}:${method}`, {
                source: e,
                trace: true,
                // TODO: alarm will not be suitable for all errors.
                alarm: true,
                extra: {
                    args,
                }
            });
            return this._driver_response_from_error(e, meta);
        }
    }

    async _driver_response_from_error (e, meta) {
        let serializable = (e instanceof APIError) || (e instanceof DriverError);
        if ( serializable ) {
            console.log('Serialized error test', JSON.stringify(
                e.serialize(), null, 2
            ))
            console.log('Serialized error message: ', e.serialize().message)
        }
        return {
            success: false,
            ...meta,
            error: serializable ? e.serialize() : e.message,
        };
    }

    async list_interfaces () {
        return this.interfaces;
    }

    async _process_args (interface_name, method_name, args) {
        const svc_registry = this.services.get('registry');
        const c_interfaces = svc_registry.get('interfaces');

        // Note: 'interface' is a strict mode reserved word.
        const interface_ = c_interfaces.get(interface_name);
        if ( ! interface_ ) {
            throw APIError.create('interface_not_found', null, { interface_name });
        }

        const processed_args = {};
        const method = interface_.methods[method_name];
        if ( ! method ) {
            throw APIError.create('method_not_found', null, { interface_name, method_name });
        }
        for ( const [arg_name, arg_descriptor] of Object.entries(method.parameters) ) {
            const arg_value = args[arg_name];
            const arg_behaviour = this.modules.types[arg_descriptor.type];

            // TODO: eventually put this in arg behaviour base class.
            // There's a particular way I want to do this that involves
            // a trait for extensible behaviour.
            if ( arg_value === undefined && arg_descriptor.required ) {
                throw APIError.create('missing_required_argument', null, {
                    interface_name,
                    method_name,
                    arg_name,
                });
            }

            const ctx = Context.get();

            try {
                processed_args[arg_name] = await arg_behaviour.consolidate(
                    ctx, arg_value, { arg_descriptor, arg_name });
            } catch ( e ) {
                throw APIError.create('argument_consolidation_failed', null, {
                    interface_name,
                    method_name,
                    arg_name,
                    message: e.message,
                });
            }
        }

        return processed_args;
    }
}

module.exports = {
    DriverService,
};
