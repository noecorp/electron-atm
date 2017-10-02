const StatesService = require('../services/states.js');
const ScreensService = require('../services/screens.js');
const FITsService = require('../services/fits.js');
const CryptoService = require('../services/crypto.js');
const DisplayService = require('../services/display.js');
const OperationCodeBufferService = require('../services/opcode.js');
const Trace = require('../controllers/trace.js');
const Pinblock = require('../controllers/pinblock.js');
const des3 = require('node-cardcrypto').des;

function ATM(settings, log) {
  /**
   * [isFDKButtonActive check whether the FDKs is active or not]
   * @param  {[type]}  button [FDK button to be checked, e.g. 'A', 'G' (case does not matter - 'a', 'g' works as well) ]
   * @return {Boolean}        [true if FDK is active, false if inactive]
   */
  this.isFDKButtonActive = function(button){
    if(!button)
      return;

    for (var i = 0; i < this.activeFDKs.length; i++)
      if(button.toUpperCase() === this.activeFDKs[i] )
        return true; 
    
    return false;
  }

  /**
   * [setFDKsActiveMask set the current FDK mask ]
   * @param {[type]} mask [1. number from 000 to 255, represented as string, OR
   *                       2. binary mask, represented as string, e.g. 100011000 ]
   */
  this.setFDKsActiveMask = function(mask){
    if(mask.length <= 3){
      // 1. mask is a number from 000 to 255, represented as string
      if(mask > 255){
        log.error('Invalid FDK mask: ' + mask);
        return;
      }

      this.activeFDKs = [];
      var FDKs = ['A', 'B', 'C', 'D', 'F', 'G', 'H', 'I'];  // E excluded
      for(var bit = 0; bit < 8; bit++)
        if((mask & Math.pow(2, bit)).toString() !== '0')
          this.activeFDKs.push(FDKs[bit]);

    } else if(mask.length > 0)
    {
      // 2. mask is a binary mask, represented as string, e.g. 100011000 
      this.activeFDKs = [];
      
      // The first character of the mask is a 'Numeric Keys activator', and is not currently processed
      mask = mask.substr(1, mask.length);

      var FDKs = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']; // E included
      for(var i = 0; i < mask.length; i++)
          if(mask[i] === '1')
            this.activeFDKs.push(FDKs[i]);
    } else
    {
      log.error('Empty FDK mask');
    }
  }

  /**
   * [replySolicitedStatus description]
   * @param  {[type]} status [description]
   * @return {[type]}        [description]
   */
  this.replySolicitedStatus = function(status, command_code){
    var reply = {};
    reply.message_class = 'Solicited';
    reply.message_subclass = 'Status'; 

    switch(status){
      case 'Ready':
      case 'Command Reject':
      case 'Specific Command Reject':
        reply.status_descriptor = status;
        break;
        
      case 'Terminal State':
        reply.status_descriptor = status;
        switch(command_code){
          case 'Send Configuration ID':
            reply.config_id = this.getConfigID();
            break;

          case 'Send Supply Counters':
            var counters = this.getSupplyCounters();
            for(var c in counters) reply[c] = counters[c];
            break;

          default:
            break;
        }
        break;

      default:
        log.error('atm.replySolicitedStatus(): unknown status ' + status);
        reply.status_descriptor = 'Command Reject';
    }
    return reply;
  };

  /**
   * [processTerminalCommand description]
   * @param  {[type]} data [description]
   * @return {[type]}      [description]
   */
  this.processTerminalCommand = function(data){
    switch(data.command_code){
      case 'Go in-service':
        this.setStatus('In-Service');
        this.processState('000');
        this.initBuffers();
        this.activeFDKs = [];
        break;
      case 'Go out-of-service':
        this.setStatus('Out-Of-Service');
        this.display.setScreenByNumber('001');
        this.initBuffers();
        this.activeFDKs = [];
        this.card = null;
        break;
      case 'Send Configuration ID':
      case 'Send Supply Counters':
        return this.replySolicitedStatus('Terminal State', data.command_code);

      default:
          log.error('atm.processTerminalCommand(): unknown command code: ' + data.command_code);
          return this.replySolicitedStatus('Command Reject');
        }
      return this.replySolicitedStatus('Ready');
  } 

  /**
   * [processCustomizationCommand description]
   * @param  {[type]} data [description]
   * @return {[type]}      [description]
   */
  this.processCustomizationCommand = function(data){
    switch(data.message_identifier){
      case 'Screen Data load':
        if(this.screens.add(data.screens))
          return this.replySolicitedStatus('Ready') 
        else
          return this.replySolicitedStatus('Command Reject');

      case 'State Tables load':
        if(this.states.add(data.states))
          return this.replySolicitedStatus('Ready') 
        else
          return this.replySolicitedStatus('Command Reject');

      case 'FIT Data load':
        if(this.FITs.add(data.FITs))
          return this.replySolicitedStatus('Ready')
        else
          return this.replySolicitedStatus('Command Reject');

      case 'Configuration ID number load':
        if(data.config_id){
          this.setConfigID(data.config_id);
          return this.replySolicitedStatus('Ready');
        }else{
          log.info('ATM.processDataCommand(): no Config ID provided');
          return this.replySolicitedStatus('Command Reject');
        }

      default:
        log.error('ATM.processDataCommand(): unknown message identifier: ', data.message_identifier);
        return this.replySolicitedStatus('Command Reject');
    }
  };

  /**
   * [processInteractiveTransactionResponse description]
   * @param  {[type]} data [description]
   * @return {[type]}      [description]
   */
  this.processInteractiveTransactionResponse = function(data){
    this.interactive_transaction = true;

    if(data.active_keys){
      this.setFDKsActiveMask(data.active_keys)
    }
    
    this.display.setScreen(this.screens.parseDynamicScreenData(data.screen_data_field));
    return this.replySolicitedStatus('Ready');
  };

  this.processExtendedEncKeyInfo = function(data){
    switch(data.modifier){
      case 'Decipher new comms key with current master key':
        if( this.crypto.setCommsKey(data.new_key_data, data.new_key_length) )
          return this.replySolicitedStatus('Ready');
        else
          return this.replySolicitedStatus('Command Reject');
        break;

      default:
        log.error('Unsupported modifier');
        break;
    }

    return this.replySolicitedStatus('Command Reject');
  }

  /**
   * [processDataCommand description]
   * @param  {[type]} data [description]
   * @return {[type]}      [description]
   */
  this.processDataCommand = function(data){
    switch(data.message_subclass){
      case 'Customization Command':
        return this.processCustomizationCommand(data);

      case 'Interactive Transaction Response':
        return this.processInteractiveTransactionResponse(data);

      case 'Extended Encryption Key Information':
        return this.processExtendedEncKeyInfo(data);
        
      default:
        log.info('atm.processDataCommand(): unknown message sublass: ', data.message_subclass);
        return this.replySolicitedStatus('Command Reject');
    }
    return this.replySolicitedStatus('Command Reject');
  }

  /**
   * [processTransactionReply description]
   * @param  {[type]} data [description]
   * @return {[type]}      [description]
   */
  this.processTransactionReply = function(data){    
    this.processState(data.next_state);

    if(data.screen_display_update)
      this.screens.parseScreenDisplayUpdate(data.screen_display_update);

    return this.replySolicitedStatus('Ready');
  };

  /**
   * [getMessageCoordinationNumber 
   *  Message Co-Ordination Number is a character assigned by the
   *  terminal to each transaction request message. The terminal assigns a
   *  different co-ordination number to each successive transaction request,
   *  on a rotating basis. Valid range of the co-ordination number is 31 hex
   *  to 3F hex, or if enhanced configuration parameter 34 ‘MCN Range’ has
   *  been set to 001, from 31 hex to 7E hex. Central must include the
   *  corresponding co-ordination number when responding with a
   *  Transaction Reply Command.
   *  
   *  This ensures that the Transaction Reply matches the Transaction
   *  Request. If the co-ordination numbers do not match, the terminal
   *  sends a Solicited Status message with a Command Reject status.
   *  Central can override the Message Co-Ordination Number check by
   *  sending a Co-Ordination Number of ‘0’ in a Transaction Reply
   *  command. As a result, the terminal does not verify that the
   *  Transaction Reply co-ordinates with the last transaction request
   *  message.]
   * @return {[type]} [description]
   */
  this.getMessageCoordinationNumber = function(){
    var saved = settings.get('message_coordination_number');
    if(!saved)
      saved = '0';

    saved = String.fromCharCode(saved.toString().charCodeAt(0) + 1);
    if(saved.toString().charCodeAt(0) > 126)
      saved = '1';

    settings.set('message_coordination_number', saved);
    return saved;
  };

  /**
   * [initBuffers clears the terminal buffers
   * When the terminal enters the Card Read State, the following buffers are initialized:
   *  - Card data buffers (no data)
   *  - PIN and General Purpose buffers (no data)
   *  - Amount buffer (zero filled)
   *  - Operation code buffer (space filled)
   *  - FDK buffer (zero filled)]
   * @return {[type]} [description]
   */
  this.initBuffers = function(){
    // In a real ATM PIN_buffer contains encrypted PIN, but in this application PIN_buffer contains clear PIN entered by cardholder.
    // To get the encrypted PIN, use getEncryptedPIN() method
    this.PIN_buffer = '';

    this.buffer_B = '';
    this.buffer_C = '';
    this.amount_buffer = '000000000000';
    this.opcode.init();
    this.FDK_buffer = '';   // FDK_buffer is only needed on state type Y and W to determine the next state

    return true;
  }

  /**
   * [processStateA process the Card Read state]
   * @param  {[type]} state [description]
   * @return {[type]}       [description]
   */
  this.processStateA = function(state){
    this.initBuffers();
    this.display.setScreenByNumber(state.screen_number)
    
    if(this.card)
      return state.good_read_next_state;
  }

  /**
   * [processPINEntryState description]
   * @param  {[type]} state [description]
   * @return {[type]}       [description]
   */
  this.processPINEntryState = function(state){
    /**
     * The cardholder enters the PIN, which can consist of from four to
     * sixteen digits, on the facia keyboard. If the cardholder enters fewer
     * than the number of digits specified in the FIT entry, PMXPN, he
     * must press FDK ‘A’ (or FDK ‘I’, if the option which enables the keys
     * to the left of the CRT is set) or the Enter key after the last digit has
     * been entered. Pressing the Clear key clears all digits.
     */
    this.display.setScreenByNumber(state.screen_number)
    this.setFDKsActiveMask('001'); // Enabling button 'A' only
    this.max_pin_length = this.FITs.getMaxPINLength(this.card.number)

    if(this.PIN_buffer.length > 3){
      // TODO: PIN encryption
      return state.remote_pin_check_next_state
    }
  }

  /**
   * [processAmountEntryState description]
   * @param  {[type]} state [description]
   * @return {[type]}       [description]
   */
  this.processAmountEntryState = function(state){
    this.display.setScreenByNumber(state.screen_number);
    this.setFDKsActiveMask('015'); // Enabling 'A', 'B', 'C', 'D' buttons
    this.amount_buffer = '000000000000';

    var button = this.buttons_pressed.shift();
    if(this.isFDKButtonActive(button))
      return state['FDK_' + button + '_next_state'];
  }

  /**
   * [processStateD description]
   * @param  {[type]} state           [description]
   * @param  {[type]} extension_state [description]
   * @return {[type]}                 [description]
   */
  this.processStateD = function(state, extension_state){
    //this.setBufferFromState(state, extension_state);
    this.opcode.setBufferFromState(state, extension_state);
    return state.next_state;
  }

  /**
   * [processFourFDKSelectionState description]
   * @param  {[type]} state [description]
   * @return {[type]}       [description]
   */
  this.processFourFDKSelectionState = function(state){
    this.display.setScreenByNumber(state.screen_number);

    this.activeFDKs= [];
    ['A', 'B', 'C', 'D'].forEach((element, index) => {
      if(state['FDK_' + element + '_next_state'] !== '255')
        this.activeFDKs.push(element);
    })

    var button = this.buttons_pressed.shift();
    if(this.isFDKButtonActive(button)){
      var index = parseInt(state.buffer_location);
      if(index < 8)
        this.opcode.setBufferValueAt(7 - index, button);
      else
        log.error('Invalid buffer location value: ' + state.buffer_location + '. Operation Code buffer is not changed');

      return state['FDK_' + button + '_next_state'];
    }
  }

  this.processInformationEntryState = function(state){
    this.display.setScreenByNumber(state.screen_number);
    var active_mask = '0';
    [state.FDK_A_next_state,
     state.FDK_B_next_state,
     state.FDK_C_next_state,
     state.FDK_D_next_state].forEach((element, index) => {
      if(element !== '255')
        active_mask += '1';
      else
        active_mask += '0';
    })
    this.setFDKsActiveMask(active_mask);

    var button = this.buttons_pressed.shift();
    if(this.isFDKButtonActive(button)){
      return state['FDK_' + button + '_next_state'];
    }

    switch(state.buffer_and_display_params[2])
    {
      case '0':
      case '1':
        this.buffer_C = '';
        break;

      case '2':
      case '3':
        this.buffer_B = '';
        break;

      default: 
        log.error('Unsupported Display parameter value: ' + this.curren_state.buffer_and_display_params[2]);
    }
  };


  /**
   * [processTransactionRequestState description]
   * @param  {[type]} state [description]
   * @return {[type]}       [description]
   */
  this.processTransactionRequestState = function(state){
    this.display.setScreenByNumber(state.screen_number);

    var request = {
      message_class: 'Unsolicited',
      message_subclass: 'Transaction Request',
      top_of_receipt: '1',
      message_coordination_number: this.getMessageCoordinationNumber(),
    };

    if(!this.interactive_transaction)
    {
      if(state.send_track2 === '001')
        request.track2 = this.track2;

      // Send Track 1 and/or Track 3 option is not supported 

      if(state.send_operation_code === '001')
        request.opcode_buffer = this.opcode.getBuffer();

      if(state.send_amount_data === '001')
        request.amount_buffer = this.amount_buffer;

      switch(state.send_pin_buffer){
        case '001':   // Standard format. Send Buffer A
        case '129':   // Extended format. Send Buffer A
          request.PIN_buffer = this.crypto.getEncryptedPIN(this.PIN_buffer, this.card.number);
          break;
        case '000':   // Standard format. Do not send Buffer A
        case '128':   // Extended format. Do not send Buffer A
        default:
          break;
      }

      switch(state.send_buffer_B_buffer_C){
        case '000': // Send no buffers
          break;

        case '001': // Send Buffer B
          request.buffer_B = this.buffer_B;
          break;

        case '002': // Send Buffer C
          request.buffer_C = this.buffer_C;
          break;

        case '003': // Send Buffer B and C
          request.buffer_B = this.buffer_B;
          request.buffer_C = this.buffer_C;
          break;

        default:
          // TODO: If the extended format is selected in table entry 8, this entry is an Extension state number.
          if(state.send_pin_buffer in ['128', '129']){
            null;
          }
          break;
      }
    } else {
      this.interactive_transaction = false;

      // Keyboard data entered after receiving an Interactive Transaction Response is stored in General Purpose Buffer B
      var button = this.buttons_pressed.shift();
      if(this.isFDKButtonActive(button)){
        this.buffer_B = button;
        request.buffer_B = button;
      }
    }


    this.transaction_request = request; // further processing is performed by the atm listener
  }

  /**
   * [processCloseState description]
   * @param  {[type]} state [description]
   * @return {[type]}       [description]
   */
  this.processCloseState = function(state){
    this.display.setScreenByNumber(state.receipt_delivered_screen);
    this.setFDKsActiveMask('000');  // Disable all FDK buttons
    this.card = null;
    log.info(trace.object(state));
  }

  /**
   * [processStateK description]
   * @param  {[type]} state [description]
   * @return {[type]}       [description]
   */
  this.processStateK = function(state){
    var institution_id = this.FITs.getInstitutionByCardnumber(this.card.number)
    // log.info('Found institution_id ' + institution_id);
    return state.states_to[parseInt(institution_id)];
  }

  /**
   * [processStateW description]
   * @param  {[type]} state [description]
   * @return {[type]}       [description]
   */
  this.processStateW = function(state){
    return state.states[this.FDK_buffer]
  }


  /**
   * [setAmountBuffer assign the provide value to amount buffer]
   * @param {[type]} amount [description]
   */
  this.setAmountBuffer = function(amount){
    if(!amount)
      return;
    this.amount_buffer = this.amount_buffer.substr(amount.length) + amount;
  };


  /**
   * [processStateX description]
   * @param  {[type]} state [description]
   * @return {[type]}       [description]
   */
  this.processStateX = function(state, extension_state){
    this.display.setScreenByNumber(state.screen_number);
    this.setFDKsActiveMask(state.FDK_active_mask);

    var button = this.buttons_pressed.shift();
    if(this.isFDKButtonActive(button)){
      this.FDK_buffer = button;

      if(extension_state){
        /**
         * Each table entry contains a value that is stored in
         * the buffer specified in the associated FDK
         * Information Entry state table (table entry 7) if the
         * specified FDK or touch area is pressed.
         */
        var buffer_value;
        [null, null, 'A', 'B', 'C', 'D', 'F', 'G', 'H', 'I'].forEach((element, index) => {
          if(button === element)
            buffer_value = extension_state.entries[index];
        })

        /**
         * Buffer ID identifies which buffer is to be edited and the number of zeros to add 
         * to the values specified in the Extension state:
         * 01X - General purpose buffer B
         * 02X - General purpose buffer C
         * 03X - Amount buffer
         * X specifies the number of zeros in the range 0-9
         */
        // Checking number of zeroes to pad
        var num_of_zeroes = state.buffer_id.substr(2, 1);
        for (var i = 0; i < num_of_zeroes; i++)
          buffer_value += '0';

        // Checking which buffer to use
        switch(state.buffer_id.substr(1, 1)){
          case '1':
            this.buffer_B = buffer_value;
            break;
  
          case '2':
            this.buffer_C = buffer_value;
            break;
  
          case '3':
            this.setAmountBuffer(buffer_value);
            break;
  
          default:
            log.error('Unsupported buffer id value: ' + state.buffer_id);
            break;
        }
      }

      return state.FDK_next_state;
    }
  }

  /**
   * [processStateY description]
   * @param  {[type]} state [description]
   * @return {[type]}       [description]
   */
  this.processStateY = function(state, extension_state){
    this.display.setScreenByNumber(state.screen_number);
    this.setFDKsActiveMask(state.FDK_active_mask);

    if(extension_state)
    {
      log.error('Extension state on state Y is not yet supported');
    }else{
      var button = this.buttons_pressed.shift();
      if(this.isFDKButtonActive(button)){
        this.FDK_buffer = button;

        // If there is no extension state, state.buffer_positions defines the Operation Code buffer position 
        // to be edited by a value in the range 000 to 007.
        this.opcode.setBufferValueAt(parseInt(state.buffer_positions), button);
       
        return state.FDK_next_state;
      }
    }
  }

  /**
   * [processStateBeginICCInit description]
   * @param  {[type]} state [description]
   * @return {[type]}       [description]
   */
  this.processStateBeginICCInit = function(state){
    return state.icc_init_not_started_next_state;
  }

  /**
   * [processStateCompleteICCAppInit description]
   * @param  {[type]} state [description]
   * @return {[type]}       [description]
   */
  this.processStateCompleteICCAppInit = function(state){
    var extension_state = this.states.get(state.extension_state);
    this.display.setScreenByNumber(state.please_wait_screen_number);

    return extension_state.entries[8]; // Processing not performed
  }

  /**
   * [processICCReinit description]
   * @param  {[type]} state [description]
   * @return {[type]}       [description]
   */
  this.processICCReinit = function(state){
    return state.processing_not_performed_next_state;
  }


  /**
   * [processSetICCDataState description]
   * @param  {[type]} state [description]
   * @return {[type]}       [description]
   */
  this.processSetICCDataState = function(state){
    // No processing as ICC cards are not currently supported
    return state.next_state;
  }


  /**
   * [processState description]
   * @param  {[type]} state_number [description]
   * @return {[type]}              [description]
   */
  this.processState = function(state_number){
    var state = this.states.get(state_number);
    var next_state = null;

    do{
      if(state){
        this.current_state = state;
        log.info('Processing state ' + state.number + state.type + ' (' + state.description + ')');
      }else
      {
        log.error('Error getting state ' + state_number + ': state not found');
        return false;
      }
        
      switch(state.type){
        case 'A':
          next_state = this.processStateA(state);
          break;

        case 'B':
          next_state = this.processPINEntryState(state);
          break;

        case 'D':
          state.extension_state !== '255' ? next_state = this.processStateD(state, this.states.get(state.extension_state)) : next_state = this.processStateD(state);
          break;

        case 'E':
          next_state = this.processFourFDKSelectionState(state);
          break;

        case 'F':
          next_state = this.processAmountEntryState(state);
          break;

        case 'H':
          next_state = this.processInformationEntryState(state);
          break;

        case 'I':
          next_state = this.processTransactionRequestState(state);
          break;

        case 'J':
          next_state = this.processCloseState(state);
          break;

        case 'K':
          next_state = this.processStateK(state);
          break;

        case 'X':
          (state.extension_state !== '255' && state.extension_state !== '000') ? next_state = this.processStateX(state, this.states.get(state.extension_state)) : next_state = this.processStateX(state);
          break;

        case 'Y':
          (state.extension_state !== '255' && state.extension_state !== '000') ? next_state = this.processStateY(state, this.states.get(state.extension_state)) : next_state = this.processStateY(state);
          break;

        case 'W':
          next_state = this.processStateW(state);
          break;

        case '+':
          next_state = this.processStateBeginICCInit(state);
          break;

        case '/':
          next_state = this.processStateCompleteICCAppInit(state);
          break;

        case ';':
          next_state = this.processICCReinit(state);
          break;

        case '?':
          next_state = this.processSetICCDataState(state);
          break;

        default:
          log.error('atm.processState(): unsupported state type ' + state.type);
          next_state = null;
      }

      if(next_state)
        state = this.states.get(next_state);
      else
        break;

    }while(state);

    return true;
  }

  /**
   * [parseTrack2 parse track2 and return card object]
   * @param  {[type]} track2 [track2 string]
   * @return {[card object]} [description]
   */
  this.parseTrack2 = function(track2){
    var card = {};
    try{
      var splitted = track2.split('=')
      card.track2 = track2;
      card.number = splitted[0].replace(';', '');
      card.service_code = splitted[1].substr(4, 3);
    }catch(e){
      log.info(e);
      return null;
    }

    return card;
  }

  this.readCard = function(cardnumber, track2_data){
    this.track2 = cardnumber + '=' + track2_data;
    this.card = this.parseTrack2(this.track2)
    if(this.card){
      log.info('Card ' + this.card.number + ' read');
      this.processState('000');
    }
  };

  /**
   * [initCounters description]
   * @return {[type]} [description]
   */
  this.initCounters = function(){
    var config_id = settings.get('config_id');
    (config_id) ? this.setConfigID(config_id) : this.setConfigID('0000');

    this.supply_counters = {};
    this.supply_counters.tsn = '0000';
    this.supply_counters.transaction_count = '0000000';
    this.supply_counters.notes_in_cassettes = '00011000220003300044';
    this.supply_counters.notes_rejected = '00000000000000000000';
    this.supply_counters.notes_dispensed = '00000000000000000000';
    this.supply_counters.last_trxn_notes_dispensed = '00000000000000000000';
    this.supply_counters.card_captured = '00000';
    this.supply_counters.envelopes_deposited = '00000';
    this.supply_counters.camera_film_remaining = '00000';
    this.supply_counters.last_envelope_serial = '00000';
  }

  this.getSupplyCounters = function(){
    return this.supply_counters;
  };

  /**
   * [setConfigID description]
   * @param {[type]} config_id [description]
   */
  this.setConfigID = function(config_id){
    this.config_id = config_id;
    settings.set('config_id', config_id);
  };

  this.getConfigID = function(){
    return this.config_id;
  };

  this.setStatus = function(status){
    this.status = status;
  };

  this.trace = new Trace();
  this.states = new StatesService(settings, log);
  this.screens = new ScreensService(settings, log);
  this.FITs = new FITsService(settings, log);
  this.crypto = new CryptoService(settings, log);
  this.display = new DisplayService(this.screens, log);
  this.pinblock = new Pinblock();
  this.opcode = new OperationCodeBufferService();

  this.setStatus('Offline');
  this.initBuffers();
  this.initCounters();
  this.current_state = {};
  this.buttons_pressed = [];
  this.activeFDKs = [];
  this.transaction_request = null;
}

/**
 * [processFDKButtonPressed description]
 * @param  {[type]} button [description]
 * @return {[type]}        [description]
 */
ATM.prototype.processFDKButtonPressed = function(button){
  // log.info(button + ' button pressed');

  switch(this.current_state.type){
    case 'B':
      if (button === 'A' && this.PIN_buffer.length >= 4)
        this.processState(this.current_state.number);
      break;

    case 'H':
      var active_mask = '0';
      [this.current_state.FDK_A_next_state,
       this.current_state.FDK_B_next_state,
       this.current_state.FDK_C_next_state,
       this.current_state.FDK_D_next_state].forEach((element, index) => {
        if(element !== '255')
          active_mask += '1';
        else
          active_mask += '0';
      })
      this.setFDKsActiveMask(active_mask);

      if(this.isFDKButtonActive(button)){
        this.buttons_pressed.push(button);
        this.processState(this.current_state.number);
      }
      break;

    default:
      // No special processing required
      this.buttons_pressed.push(button);
      this.processState(this.current_state.number);
      break;
  };
};


/**
 * [processPinpadButtonPressed description]
 * @param  {[type]} button [description]
 * @return {[type]}        [description]
 */
ATM.prototype.processPinpadButtonPressed = function(button){
  //log.info('Button ' + button + ' pressed');
  switch(this.current_state.type){
    case 'B':
      switch(button){
        case 'backspace':
          this.PIN_buffer = this.PIN_buffer.slice(0, -1);
          break;

        case 'enter':
          if(this.PIN_buffer.length >= 4)
            this.processState(this.current_state.number)
          break;

        case 'esc':
          this.PIN_buffer = '';
          break;

        default:
          this.PIN_buffer += button;
          if(this.PIN_buffer.length == this.max_pin_length)
            this.processState(this.current_state.number)
      }
      this.display.insertText(this.PIN_buffer, '*');
      break;

    case 'F':
      switch(button){
        case 'enter':
          // If the cardholder presses the Enter key, it has the same effect as pressing FDK ‘A’
          this.buttons_pressed.push('A');
          this.processState(this.current_state.number)
          break;

        case 'backspace':
          this.amount_buffer = '0' + this.amount_buffer.substr(0, this.amount_buffer.length - 1);
          this.display.insertText(this.amount_buffer);
          break;

        case 'esc':
          // TODO: clear buffer
          break;

        default:
          this.amount_buffer = this.amount_buffer.substr(1) + button;
          this.display.insertText(this.amount_buffer);
          break;
      }
      break;

    case 'H':
      if( this.current_state.buffer_and_display_params[2] === '0' || this.current_state.buffer_and_display_params[2] === '1'){
        switch(button){
          case 'backspace':
            this.buffer_C = this.buffer_C.substr(0, this.buffer_C.length - 1);
            if(this.current_state.buffer_and_display_params[2] === '0'){
              // 0 - Display 'X' for each numeric key pressed. Store data in general-purpose Buffer C
              this.display.insertText(this.buffer_C, 'X');
            } else if(this.current_state.buffer_and_display_params[2] === '1'){
              // 1 - Display data as keyed in. Store data in general-purpose Buffer C
              this.display.insertText(this.buffer_C);
            };
            break;

          case 'esc':
            // TODO: clear buffer
            break;

          default:
            if(this.buffer_C.length < 32){
              this.buffer_C += button;

              if(this.current_state.buffer_and_display_params[2] === '0'){
                // 0 - Display 'X' for each numeric key pressed. Store data in general-purpose Buffer C
                this.display.insertText(this.buffer_C, 'X');
              } else if(this.current_state.buffer_and_display_params[2] === '1'){
                // 1 - Display data as keyed in. Store data in general-purpose Buffer C
                this.display.insertText(this.buffer_C);
              }
            }
            break;
        }
      } else if(  this.current_state.buffer_and_display_params[2] === '2' || this.current_state.buffer_and_display_params[2] === '3'){
        switch(button){
          case 'backspace':
            this.buffer_B = this.buffer_B.substr(0, this.buffer_B.length - 1)
            if(  this.current_state.buffer_and_display_params[2] === '2'){
              // 2 - Display 'X' for each numeric key pressed. Store data in general-purpose Buffer B
              this.display.insertText(this.buffer_B, 'X');
            } else if(this.current_state.buffer_and_display_params[2] === '3'){
              // 3 - Display data as keyed in. Store data in general-purpose Buffer B
              this.display.insertText(this.buffer_B);
            }
            break;

          case 'esc':
            // TODO: clear buffer
            break;

          default:
            if(this.buffer_B.length < 32){
              this.buffer_B += button;

              if(  this.current_state.buffer_and_display_params[2] === '2'){
                // 2 - Display 'X' for each numeric key pressed. Store data in general-purpose Buffer B
                this.display.insertText(this.buffer_B, 'X');
              } else if(this.current_state.buffer_and_display_params[2] === '3'){
                // 3 - Display data as keyed in. Store data in general-purpose Buffer B
                this.display.insertText(this.buffer_B);
              }
            }
            break;
        }
      } else
        log.error('Unsupported Display parameter value: ' + this.curren_state.buffer_and_display_params[2]);

      break;

    default:
      log.error('No keyboard entry allowed for state type ' + this.current_state.type);
      break;
  }
};

/**
 * [processHostMessage description]
 * @param  {[type]} data [description]
 * @return {[type]}      [description]
 */
ATM.prototype.processHostMessage = function(data){
  switch(data.message_class){
    case 'Terminal Command':
      return this.processTerminalCommand(data);

    case 'Data Command':
      return this.processDataCommand(data);

    case 'Transaction Reply Command':
      return this.processTransactionReply(data);
            
    default:
      log.info('ATM.processHostMessage(): unknown message class: ' + data.message_class);
      break;
  }
  return false;
};

module.exports = ATM;
